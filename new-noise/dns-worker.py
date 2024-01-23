import subprocess
import json
import psycopg2
import os
import redis
import ray
import tldextract
from utils import send_slack_message, push_to_redis_queue  # Using utility functions
import config  # Ensure this module has the required configurations
import logging

# Initialize logging
logging.basicConfig(level=logging.INFO)

# Global configurations
error_channel = '#errors'
takeover_channel = '#takeover'
ns_takeover_channel = '#ns_takeover'
ignore_file = "ignore_tko_domains.txt"
file_path = 'hostname'
queue_name = 'to_dnsx'
max_workers = 50

def get_tld(domain):
    ext = tldextract.extract(domain)
    return ext.registered_domain

def filter_domain_if_in_ignore_list(input_domain, ignore_file):
    try:
        with open(ignore_file, 'r') as file:
            ignore_list = set(line.strip() for line in file)
        return None if any(input_domain.endswith(item) for item in ignore_list) else input_domain
    except FileNotFoundError:
        return input_domain

def check_cname_with_empty_a(json_data, domains_to_check):
    host = json_data.get("host")
    cname_entries = json_data.get("cname", [])
    a_entries = json_data.get("a", [])
    status_code = json_data.get("status_code")

    if status_code == "NXDOMAIN" and not a_entries:
        for cname in cname_entries:
            if cname.endswith(tuple(domains_to_check)):
                logging.info(f"Vulnerable Dangling CName: {host}")
                send_slack_message(takeover_channel, f"Vulnerable Dangling CName found: {cname_entries} for host {host}")

def check_ns_takeover(json_data):
    host = json_data.get("host")
    trace_chain = json_data.get("trace", {}).get("chain", [])

    if trace_chain and len(trace_chain) >= 2:
        ns_values = trace_chain[-2].get("ns", [])
        if any("awsdns" in ns for ns in ns_values):
            logging.info(f"Vulnerable NS Servers found for: {host}")
            send_slack_message(ns_takeover_channel, f"Vulnerable NS Records found: {ns_values} for host {host}")

@ray.remote(num_cpus=1)

def run_dnsx(subdomain, matched_domain, program_id):
    print(f"Running dnsx for: {subdomain}, Matched Domain: {matched_domain}, Program ID: {program_id}")
    dnsx_cmd = [
        'dnsx', '-silent', '-t', '200', '-json', '-asn', '-wd', matched_domain,
        '-rcode', 'noerror,servfail,refused,nxdomain', 
        '-r', '8.8.8.8,8.8.4.4,1.1.1.1,9.9.9.9,208.67.222.222,84.200.69.80,64.6.64.6,8.26.56.26,205.171.3.65,134.195.4.2,185.2228.168.9,76.76.19.19,37.235.1.177,77.88.8.1,94.140.14.140,38.132.106.139,74.82.42.42,76.76.2.0'
    ]

    try:
        # Use echo command to pipe the subdomain to dnsx command
        echo_cmd = ['echo', subdomain]
        echo_proc = subprocess.Popen(echo_cmd, stdout=subprocess.PIPE)
        dnsx_proc = subprocess.Popen(dnsx_cmd, stdin=echo_proc.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        output, error = dnsx_proc.communicate()
        print(f"DNSx Output: {output}")
        print(f"DNSx Error: {error}")
        echo_proc.stdout.close()

        if dnsx_proc.returncode == 0 and output.strip():
            try:
                data = json.loads(output)
                return data
            except json.JSONDecodeError as je:
                logging.error(f"JSON decoding error for subdomain {subdomain}: {je}")
                return None
        else:
            logging.error(f"Error or no output while running dnsx for subdomain {subdomain}: {error}")
            return None

    except Exception as e:
        logging.error(f"General error occurred while running dnsx for subdomain {subdomain}: {e}")
        return None

def send_to_db(root_domain, payload,redis_params):
    print(f"Sending to Redis: {payload}")
    try:
        if payload:
            redis_conn = redis.Redis(**redis_params)
            # Convert the payload to JSON and send it to the process_data_dns queue
            for i in payload:
                redis_conn.rpush("process_data_dns", json.dumps(i))
            print(f"Subdomains sent to process_data_dns queue for domain: {root_domain}")
        else:
            print(f"No subdomains found for domain: {root_domain}")

    except subprocess.CalledProcessError as e:
        print(f"Error occurred while running subs module for subdomain {root_domain}: {e}")
        message = f"```Error occurred in subs module while running for Subdomain on {host_hostname}: {root_domain} \n # Error: {e}```"
        send_slack_message(error_channel, message)
    except redis.ConnectionError as re:
        print(f"Error connecting to Redis while sending subdomains for domain {root_domain}: {re}")
        message = f"```Error occurred in subs module while connecting to Redis while sending subdomains for domain on {host_hostname}: {root_domain} \n # Error: {re}```"
        send_slack_message(error_channel, message)
    except Exception as ex:
        print(f"Error in send_to_db for domain {root_domain}: {ex}")
        message = f"```Error occurred in subs module in send_to_db for domain on {host_hostname}: {root_domain} \n # Error: {ex}```"
        send_slack_message(error_channel, message)
    
    
def main():
    ray.init()

    # Read host hostname
    with open(file_path, 'r') as file:
        host_hostname = file.read().strip()

    # Redis and other configurations
    redis_params = {
        'host': config.redis_host,
        'port': config.redis_port,
        'password': config.redis_password,
        'ssl': True
    }

    # Establish Redis connection
    redis_conn = redis.Redis(**redis_params)
    pending_futures = {}

    try:
        while True:
            if len(pending_futures) < max_workers:
                subdomain_tuple = redis_conn.blpop(queue_name, timeout=5)
                if subdomain_tuple:
                    subdomain_data = subdomain_tuple[1].decode('utf-8')
                    raw_data = subdomain_tuple[1].decode('utf-8')
                    print(f"Raw data from Redis: {raw_data}")
                    json_data = json.loads(subdomain_data)
                    print(f"Decoded JSON data: {json_data}")
                    print(f"Received from Redis: {json_data}")
                    subdomain = json_data['subdomain']
                    matched_domain = json_data['root_domain']
                    program_id = json_data['program_id']
                    future = run_dnsx.remote(subdomain, matched_domain, program_id)
                    pending_futures[future] = (subdomain, matched_domain, program_id)

            done_ids, _ = ray.wait(list(pending_futures), num_returns=1, timeout=0)
            for done_id in done_ids:
                subdomain, matched_domain, program_id = pending_futures.pop(done_id)
                data = ray.get(done_id)
                if data:
                    payload = {"subdomain": subdomain, "data_source": "dnsx", "data": data, "program_id": program_id}
                    send_to_db(matched_domain, [payload], redis_params)

    except redis.ConnectionError as e:
        logging.error(f"Error connecting to Redis: {e}")
    except Exception as e:
        logging.error(f"Unexpected error: {e}")
    finally:
        ray.shutdown()

if __name__ == "__main__":
    main()
