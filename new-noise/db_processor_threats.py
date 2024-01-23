import json
import psycopg2
import redis
import concurrent.futures
import config
from utils import send_slack_message  # Assuming this is defined in utils.py

# Global configurations
error_channel = '#errors'
queue_name = 'process_data_threats'
max_workers = 10  # Adjust as needed
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

def store_data_from_threats_queue(threat_results, program_id, db_params):
    print(f"[*] Storing threats data for Program ID: {program_id}")

    for threat in threat_results:
        # Extract relevant values from each threat item
        template_id = threat.get("template-id")
        info = threat.get("info", {})
        name = info.get("name")
        severity = info.get("severity")
        matched_at = threat.get("matched-at")  # Ensure this is the correct field

        print(f"[*] Extracted values: Template ID: {template_id}, Name: {name}, Severity: {severity}, Matched At: {matched_at}, Program ID: {program_id}")

        # Database insertion logic for each threat item
        try:
            with psycopg2.connect(**db_params) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("""
                        INSERT INTO threats (template_id, name, severity, matched_at, program_id)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (template_id, name, matched_at, program_id) DO UPDATE
                        SET severity = EXCLUDED.severity
                        """,
                        (template_id, name, severity, matched_at, program_id))
                    conn.commit()
                    print(f" [*] Upserted threat entry for template_id: {template_id}")
        except psycopg2.Error as pe:
            print(f" [*] Database error: {pe}")
            if conn:
                conn.rollback()



## # Prepare a payload for pushing to the Redis queue if further processing is needed
   ## payload = json.dumps({
   ##     "template_id": template_id,
   ##     "name": name,
   ##     "severity": severity,
   ##     "matched_at": matched_at,
   ##     "program_id": program_id
   ## })

    # Push payload to the Redis queue using batch push function
    # push_to_redis_queue("to_next_step", [payload], redis_params)

def process_json_data(json_data, db_params):
    print(f"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n[Debug] Processing JSON data: {json_data}")
    if json_data is None:
        print("\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n[Debug] JSON data is None. Skipping...")
        return
    if json_data.get("data_source") != "threats":
        print(f"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n[Debug] Data source is not 'threats'. It's {json_data.get('data_source')}")
        return

    program_id = json_data.get("program_id")
    threat_results = json_data.get("result")  # Changed from 'data' to 'result'
    print(f"[Debug] Program ID: {program_id}, Threats Data: {threat_results}")
    if program_id and threat_results:
        store_data_from_threats_queue(threat_results, program_id, db_params)
    else:
        print("[Debug] Either program_id is missing or threats_data is empty")

def main():
    redis_conn = redis.Redis(**redis_params)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        while True:
            data_items = redis_conn.blpop(queue_name, timeout=0)
            if data_items:
                print(f"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nRetrieved data from Redis queue: {data_items[1]}")
                try:
                    json_data = json.loads(data_items[1].decode('utf-8'))
                    executor.submit(process_json_data, json_data, db_params)
                except Exception as e:
                    print(f"[Error] Failed to process data from Redis queue: {e}")

if __name__ == "__main__":
    main()