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
import config

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

def store_data_from_httpx_queue(http_data, program_id, db_params, redis_params):
    # Skip if program_id is missing or URL is None
    url = http_data.get("url")
    if not program_id or not url:
        print("Ignoring data due to missing program_id or URL.")
        return

    # Extract necessary fields from http_data
    timestamp = http_data.get("timestamp")
    title = http_data.get("title")
    status_code = http_data.get("status_code")

    with psycopg2.connect(**db_params) as conn:
        with conn.cursor() as cursor:
            # Attempt to insert or update the entry in the recon table
            try:
                cursor.execute("""
                    INSERT INTO recon (url, title, timestamp, status_code, program_id)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (url) DO UPDATE
                    SET title = EXCLUDED.title,
                        timestamp = EXCLUDED.timestamp,
                        status_code = EXCLUDED.status_code,
                        program_id = EXCLUDED.program_id
                    """,
                    (url, title, timestamp, status_code, program_id))
                conn.commit()
                print(f"Upserted database entry for URL: {url}")
            except psycopg2.Error as pe:
                conn.rollback()
                print(f"Database error for URL '{url}': {pe}")

    # Prepare payload for pushing to the Redis queue
    payload = json.dumps({
        "url": url,
        "program_id": program_id
    })

    # Push payload to the Redis queue using batch push function
    push_to_redis_queue("to_nuc", [payload], redis_params)




def process_json_data(json_data, db_params, redis_params):
    if json_data is None:
        print("No JSON data received. Skipping...")
        return

    data_source = json_data.get("data_source")

    if data_source is None:
        print("No data source found in JSON data. Skipping...")
        return

    elif data_source == "httpx":
        program_id = json_data.get("program_id")
        # Proceed only if program_id is provided
        if program_id:
            # Assume http_data is nested within json_data and contains the HTTPx result
            http_data = json_data.get("data")
            if http_data:
                store_data_from_httpx_queue(http_data, program_id, db_params, redis_params)
            else:
                print("No HTTPx data found.")
        else:
            print("No program_id found in JSON data.")

def main():
    queue_name = 'process_data_http'
    max_workers = 10  # Maximum number of parallel HTTPx workers
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
                data_items = redis_conn.blpop(queue_name, timeout=0)  # Blocking pop with no timeout
                if data_items:
                    http_data = json.loads(data_items[1].decode('utf-8'))
                    # Process HTTPx result; assuming the 'process_json_data' function takes the complete http_data, including the program_id
                    executor.submit(process_json_data, http_data, db_params, redis_params)
        except redis.ConnectionError as e:
            print(f"Error connecting to Redis: {e}")
        except Exception as ex:
            print(f"An unexpected error occurred: {ex}")
        finally:
            redis_conn.close()

# You may need to adjust the 'process_json_data' function to pass the db_params and redis_params to 'store_data_from_httpx_queue'.

if __name__ == "__main__":
    main()
