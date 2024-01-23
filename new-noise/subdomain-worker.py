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


# Initialize logging
logging.basicConfig(level=logging.INFO)

def get_or_create_program_id(conn, cursor, root_domain):
    # Check if the root domain already exists in the programs table
    cursor.execute("SELECT program_id FROM programs WHERE root_domain = %s", (root_domain,))
    result = cursor.fetchone()
    if result:
        return result[0]  # program_id already exists

    # Insert a new program as it does not exist
    cursor.execute("INSERT INTO programs (program_name, root_domain) VALUES (%s, %s) RETURNING program_id", (root_domain, root_domain))
    program_id = cursor.fetchone()[0]
    conn.commit()
    print(f"Samuel {program_id}")
    return program_id
    

def create_json_blob(subdomain, root_domain, program_id):
    data = {
        "subdomain": subdomain,
        "root_domain": root_domain,
        "program_id": program_id,
    }
    return data

@ray.remote
def run_subfinder(root_domain, db_params, redis_params):
    print(f"Starting run_subfinder for domain: {root_domain}")
    try:
        with psycopg2.connect(**db_params) as db_conn:
            cursor = db_conn.cursor()
            program_id = get_or_create_program_id(db_conn, cursor, root_domain)
            print(f"Program ID obtained for {root_domain}: {program_id}")

            # Run subfinder
            subfinder_cmd = f'subfinder -d {root_domain} -silent -all -recursive'
            all_domains = subprocess.check_output(subfinder_cmd, shell=True, text=True, timeout=120).strip().splitlines()
            print(f"Subfinder completed for domain: {root_domain}")

            # Fetch existing subdomains from the database
            cursor.execute("SELECT subdomain FROM all_domains WHERE root_domain = %s", (root_domain,))
            existing_subdomains = {row[0] for row in cursor.fetchall()}

            # Filter out new subdomains
            new_subdomains = set(all_domains) - existing_subdomains
            print(f"New unique subdomains: {new_subdomains}")

            # Insert new subdomains into the database using CSV file
            if new_subdomains:
                csv_filename = f"{root_domain}.csv"
                with open(csv_filename, 'w', newline='') as f:
                    writer = csv.writer(f)
                    for subdomain in new_subdomains:
                        writer.writerow([root_domain, subdomain])
                with open(csv_filename, 'r') as f:
                    cursor.copy_from(f, 'all_domains', sep=',', columns=('root_domain', 'subdomain'))
                db_conn.commit()
                os.remove(csv_filename)
                print(f"Inserted new subdomains for domain: {root_domain}")

            # Prepare and send data to Redis
            batch_size = 100
            for i in range(0, len(new_subdomains), batch_size):
                    batch = [create_json_blob(subdomain, root_domain, program_id) for subdomain in list(new_subdomains)[i:i + batch_size]]
                    print(f"Preparing to send to Redis: {batch}")
                    send_to_db(root_domain, batch, redis_params)


            cursor.close()
            return f"Subfinder, DB, and Redis operations successful for {root_domain}"

    except Exception as e:
        logging.error(f"Error in run_subfinder for domain {root_domain}: {e}")
        return f"Error in run_subfinder for domain {root_domain}: {e}"




def process_domains_with_ray(domains, db_params, redis_params):
    print("Inside process_domains_with_ray")
    futures = [run_subfinder.remote(domain, db_params, redis_params) for domain in domains]
    print(f"Futures created: {futures}")
    results = ray.get(futures)
    print(f"Results obtained: {results}")
    return results



def send_to_db(root_domain, payload, redis_params):
    try:
        if payload:
            redis_conn = redis.Redis(**redis_params)
            # Convert the payload to JSON and log before sending it to the Redis queue
            for i in payload:
                json_payload = json.dumps(i)
                print(f"Sending to Redis queue 'to_dnsx': {json_payload}")
                redis_conn.rpush("to_dnsx", json_payload)
            print(f"Subdomains sent to process_data queue for domain: {root_domain}")
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
    # Initialize Ray
    print("Initializing Ray")
    ray.init()

    # Parse command-line arguments
    parser = argparse.ArgumentParser(description="Run Subdomain Worker with domain list")
    parser.add_argument('-d', '--domains', type=str, help="Comma-separated list of domains to process", required=True)
    args = parser.parse_args()

    # Database and Redis configuration
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

    # Process each domain with Ray
    print("Starting main function")
    domain_list = [domain.strip() for domain in args.domains.split(',')]
    print(f"Domain list: {domain_list}")
    results = process_domains_with_ray(domain_list, db_params, redis_params)
    print(f"Results from process_domains_with_ray: {results}")

    # Log the results
    logging.info(f"Processing results: {results}")

    # Shutdown Ray
    ray.shutdown()

if __name__ == "__main__":
    main()