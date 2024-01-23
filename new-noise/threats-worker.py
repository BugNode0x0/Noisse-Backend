import subprocess
import json
import redis
import ray
import config
from utils import send_slack_message  # Assuming this is defined in utils.py

# Global configurations
error_channel = '#errors'
queue_name = 'to_nuc'  # Update to your threats queue name
max_workers = 50  # Increase as needed
file_path = 'hostname'
ignore_file = "ignore_tko_domains.txt"

# Redis configurations
redis_params = {
    'host': config.redis_host,
    'port': config.redis_port,
    'password': config.redis_password,
    'ssl': True
}


# Initialize Ray
ray.init()


# Function to filter domain against ignore list
def filter_domain_if_in_ignore_list(input_domain, ignore_file):
    if not input_domain:
        return None

    try:
        with open(ignore_file, 'r') as file:
            ignore_list = set(line.strip() for line in file)
        return None if any(input_domain.endswith(ignore_item) for ignore_item in ignore_list) else input_domain
    except FileNotFoundError:
        return input_domain

# Ray remote function to run Nuclei
@ray.remote(num_cpus=1)
def run_nuclei(url):
    print(f"Running Nuclei on: {url}")
    filtered_url = filter_domain_if_in_ignore_list(url, ignore_file)
    if not filtered_url:
        return None

    nuclei_cmd = ['nuclei', '-u', url, '-jsonl', '-c', '200', '-silent', '-t', '/Users/sam/nuclei-templates/http/technologies/tech-detect.yaml']
    try:
        proc = subprocess.Popen(nuclei_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        output, error = proc.communicate()
        if proc.returncode == 0 and output:
            result = [json.loads(line) for line in output.strip().split('\n') if line.strip()]
            print(f"Nuclei results for {url}: {result}")  # Add this line
            return result
        else:
            print(f"Nuclei processing failed for {url}. Error: {error}")
            return {"error": error.strip()}
    except Exception as e:
        return {"error": str(e)}

# Function to send data to Redis

def send_to_redis(payload, redis_params):
    print(f"Sending payload to Redis: {payload}")
    try:
        # Include 'data_source': 'threats' in the payload
        enriched_payload = {
            "url": payload.get('url'),
            "result": payload.get('result'),
            "program_id": payload.get('program_id'),
            "data_source": "threats"  # Add this line
        }
        print(f"Preparing to send payload to Redis for {payload['url']}")
        redis_conn = redis.Redis(**redis_params)
        redis_conn.rpush("process_data_threats", json.dumps(enriched_payload))
        print(f"Payload pushed to Redis queue 'process_data_threats' for {payload['url']}")
    except Exception as e:
        send_slack_message(error_channel, f"Error sending data to Redis: {e}")

def main():
    redis_conn = redis.Redis(**redis_params)
    pending_futures = {}

    try:
        while True:
            print("Checking for new URLs in the Redis queue...")
            if len(pending_futures) < max_workers:
                url_tuple = redis_conn.blpop(queue_name, timeout=5)
                if url_tuple:
                    url_data = json.loads(url_tuple[1].decode('utf-8'))
                    print(f"Received URL data from Redis: {url_data}")
                    url = url_data.get('url')
                    program_id = url_data.get('program_id')

                    if url:  # Check if URL is not None
                        future = run_nuclei.remote(url)
                        pending_futures[future] = (url, program_id)

            done_ids, _ = ray.wait(list(pending_futures.keys()), num_returns=1, timeout=0)
            for done_id in done_ids:
                url, program_id = pending_futures.pop(done_id)
                result = ray.get(done_id)
                print(f"Result for {url}: {result}")
                payload = {"url": url, "result": result, "program_id": program_id}
                print(f"Payload to be sent to Redis: {payload}")  # Add this line
                send_to_redis(payload, redis_params)

    except redis.ConnectionError as e:
        send_slack_message(error_channel, f"Redis connection error: {e}")
    except Exception as e:
        send_slack_message(error_channel, f"Unexpected error in threats worker: {e}")
    finally:
        ray.shutdown()

if __name__ == "__main__":
    main()
