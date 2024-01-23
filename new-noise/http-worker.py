import subprocess
import json
import psycopg2
import concurrent.futures
import os
import csv
import logging
import ray
import redis
import argparse
from psycopg2.extras import execute_batch
from utils import send_slack_message, push_to_redis_queue  # Assuming utils.py contains these functions
import config  # Assuming this contains necessary configurations
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

# Global configurations and setup
error_channel = '#errors'
ignore_file = "ignore_tko_domains.txt"
max_workers = 50
queue_name = 'to_httpx'
file_path = 'hostname'

# Initialize Ray
ray.init()

# Read host hostname
with open(file_path, 'r') as file:
    host_hostname = file.read().strip()

# Redis configurations
redis_params = {
    'host': config.redis_host,
    'port': config.redis_port,
    'password': config.redis_password,
    'ssl': True
}

# Function to send Slack messages
def send_slack_message(channel, message):
    try:
        # Initialize a Slack Web API client
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

def push_to_redis_queue(queue_name, data):
    try:
        redis_conn = redis.Redis(host=config.redis_host, port=config.redis_port, password=config.redis_password, ssl=True)
        redis_conn.lpush(queue_name, *data)
        print(f"Pushed {len(data)} items to the Redis queue: {queue_name}")
    except redis.ConnectionError as re:
        print(f"Error connecting to Redis: {re}")

def filter_domain_if_in_ignore_list(input_domain, ignore_file):
    try:
        with open(ignore_file, 'r') as file:
            ignore_list = set(line.strip() for line in file)

        if any(input_domain.endswith(ignore_item) for ignore_item in ignore_list):
            return None  # Input domain is in the ignore list, so filter it out
        else:
            return input_domain
    except FileNotFoundError:
        return input_domain  # Ignore file not found, do not filter
    


# Ray remote function to run HTTPx 
@ray.remote(num_cpus=1)

def run_httpx(subdomain):
    filtered_domain = filter_domain_if_in_ignore_list(subdomain, ignore_file)
    if not filtered_domain:
        return None

    httpx_cmd = ['httpx', '-silent', '-t', '200', '-json']
    try:
        proc = subprocess.Popen(httpx_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        output, error = proc.communicate(input=subdomain)
        if proc.returncode == 0 and output:
            return json.loads(output)
        else:
            return {"error": error.strip()}
    except Exception as e:
        return {"error": str(e)}

# Function to send data to Redis
def send_to_redis(subdomain, result, program_id, redis_params):
    try:
        redis_conn = redis.Redis(**redis_params)
        enriched_payload = {
            "subdomain": subdomain,
            "data": result,  # Assuming result contains the HTTPx data
            "data_source": "httpx",
            "program_id": program_id  # Include program_id
        }
        redis_conn.rpush("process_data_http", json.dumps(enriched_payload))
    except Exception as e:
        send_slack_message(error_channel, f"Error sending data to Redis: {e}")



def main():
    redis_conn = redis.Redis(**redis_params)
    pending_futures = {}

    try:
        while True:
            if len(pending_futures) < max_workers:
                subdomain_tuple = redis_conn.blpop(queue_name, timeout=5)
                if subdomain_tuple:
                    subdomain_data = json.loads(subdomain_tuple[1].decode('utf-8'))
                    subdomain = subdomain_data['subdomain']
                    program_id = subdomain_data['program_id']  # Extract program_id
                    future = run_httpx.remote(subdomain)
                    pending_futures[future] = (subdomain, program_id)

            done_ids, _ = ray.wait(list(pending_futures), num_returns=1, timeout=0)
            for done_id in done_ids:
                subdomain, program_id = pending_futures.pop(done_id)  # Extract program_id
                result = ray.get(done_id)
                if result:
                    send_to_redis(subdomain, result, program_id, redis_params)  # Pass program_id


    except redis.ConnectionError as e:
        send_slack_message(error_channel, f"Redis connection error: {e}")
    except Exception as e:
        send_slack_message(error_channel, f"Unexpected error in HTTPx worker: {e}")
    finally:
        ray.shutdown()

if __name__ == "__main__":
    main()