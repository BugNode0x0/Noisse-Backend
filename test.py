import psycopg2
from psycopg2 import OperationalError

# Define your PostgreSQL credentials and table name
db_host = "monorail.proxy.rlwy.net"
db_port = "30168"
db_name = "railway"
db_user = "postgres"
db_password = "Efb5GEDCg4bG-ebA34b*DG5cAE-2-AG2"
table_name = "asm"  # Replace with your actual table name

def gather_asm_information():
    try:
        # Establish a connection to the PostgreSQL database
        connection = psycopg2.connect(
            host=db_host,
            port=db_port,
            database=db_name,
            user=db_user,
            password=db_password
        )

        # Create a cursor object
        cursor = connection.cursor()

        # Execute a SELECT query to gather information from the "asm" table
        cursor.execute(f"SELECT * FROM {table_name}")

        # Fetch all rows from the result
        rows = cursor.fetchall()

        # Print the gathered information
        for row in rows:
            print(row)  # You can format and process the data as needed

        # Close the cursor and connection
        cursor.close()
        connection.close()

    except OperationalError as e:
        print(f"Error: {e}")
        print("Connection to PostgreSQL failed. Credentials may be incorrect.")

if __name__ == "__main__":
    gather_asm_information()
