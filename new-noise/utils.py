# utils.py

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
import redis
import config

def send_slack_message(channel, message):
    try:
        slack_token = config.slack_token
        client = WebClient(token=slack_token)
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
