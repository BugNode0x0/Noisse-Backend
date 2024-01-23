import json
import psycopg2
from psycopg2.extras import Json
import config
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
import os
import redis
import concurrent.futures
import psycopg2.pool

error_channel = '#errors'
notify_channel = '#vulns'

def send_slack_message(channel, message):
    try:
        slack_token = config.slack_token
        client = WebClient(token=slack_token)
        # Send a message to the specified channel
        response = client.chat_postMessage(channel=channel, text=message)
        if response['ok']:
            print(f"Message sent successfully to channel {channel}")
        else:
            print("Failed to send message")
    except SlackApiError as e:
        print(f"Error sending Slack message: {e.response['error']}")

def push_to_redis_queue(queue_name, data_list, redis_params):
    try:
        redis_conn = redis.Redis(**redis_params)
        # Use pipeline to batch the LPUSH operations
        pipeline = redis_conn.pipeline()
        for data in data_list:
            pipeline.lpush(queue_name, data)
        pipeline.execute()
        print(f"Pushed {len(data_list)} items to the Redis queue: {queue_name}")
    except Exception as exc:  # Broad exception handling, be more specific if needed
        print(f"Error connecting to Redis or pushing data: {exc}")

def store_data_from_dns_queue(json_data, db_params, redis_params):
    program_id = json_data.get("program_id")
    if not program_id:
        print(f"Ignoring data with program_id 0.")
        return

    dns_data = json_data.get("data")
    if not dns_data:
        print(f"No DNS data available for program_id {program_id}.")
        return

    timestamp = dns_data.get("timestamp")
    host = dns_data.get("host")
    a_entries = dns_data.get("a", [])  # Ensure it's always a list, even if it's empty or None
    status_code = dns_data.get("status_code")

    payloads_to_push = []  # Prepare a list to collect payloads for the Redis queue

    with psycopg2.connect(**db_params) as conn:
        with conn.cursor() as cursor:
            # Process each A entry, including a None entry if a_entries is empty
            for a_entry in a_entries if a_entries else [None]:
                try:
                    cursor.execute("""
                        INSERT INTO dns (host, a, timestamp, program_id, status_code)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (host, a) DO UPDATE
                        SET timestamp = EXCLUDED.timestamp, program_id = EXCLUDED.program_id, status_code = EXCLUDED.status_code
                        """,
                        (host, a_entry, timestamp, program_id, status_code)
                    )
                    action = "Inserted" if a_entry is not None else "Updated with NULL A record"
                    print(f"{action} database entry for host '{host}' with A record '{a_entry}'.")
                except psycopg2.Error as pe:
                    conn.rollback()
                    print(f"Error occurred while upserting data for host '{host}' with A record '{a_entry}': {pe}")

            # Commit any successful operations in the database
            conn.commit()

            # Prepare a payload for the Redis queue if we have a valid host and program_id
            if host and program_id:
                payload = json.dumps({
                    "subdomain": host,
                    "program_id": program_id
                })
                payloads_to_push.append(payload)  # Append it to the list for batch processing

    # Push the collected payloads to the Redis queue in a batch
    if payloads_to_push:
        push_to_redis_queue("to_httpx", payloads_to_push, redis_params)

# Make sure to have the push_to_redis_queue function defined elsewhere in your code.

# Not used anywhere as of now. Maybe remove it later.
def process_json_data(json_data, db_params, redis_params):
    if json_data is None:
        print("No JSON data received. Skipping...")
        return

    data_source = json_data.get("data_source")
    if data_source is None:
        print("No data source found in JSON data. Skipping...")
        return

    if data_source == "dnsx":
        print("Processing data from DNSx:")
        store_data_from_dns_queue(json_data, db_params, redis_params)

def main():
    queue_name = 'process_data_dns'
    max_workers = 10
    db_params = {
        'host': config.db_host,
        'port': config.db_port,
        'dbname': config.db_name,
        'user': config.db_user,
        'password': config.db_password
    }
    redis_params = {
        'host': config.redis_host,
        'port': config.redis_port,
        'password': config.redis_password,
        'ssl': True
    }

    redis_conn = redis.Redis(**redis_params)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        try:
            while True:
                # Blocking wait for data from the Redis queue with no timeout
                data_items = redis_conn.blpop(queue_name)
                if data_items:
                    json_data = json.loads(data_items[1].decode('utf-8'))
                    # Submit a single task to the executor
                    executor.submit(store_data_from_dns_queue, json_data, db_params, redis_params)
        except redis.ConnectionError as e:
            print(f"Error connecting to Redis: {e}")
        except Exception as ex:
            print(f"An unexpected error occurred: {ex}")
        finally:
            redis_conn.close()

if __name__ == "__main__":
    main()
