import os
import mysql.connector
from dotenv import load_dotenv

# Load environment variables
DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
load_dotenv(dotenv_path=DOTENV_PATH)

def test_db_connection():
    db_config = {
        "host": os.getenv("MYSQL_HOST"),
        "user": os.getenv("MYSQL_USER"),
        "password": os.getenv("MYSQL_PASSWORD"),
        "database": os.getenv("MYSQL_DATABASE"),
        "auth_plugin": "mysql_native_password",
    }

    print("Attempting to connect to MySQL with the following configuration:")
    for k, v in db_config.items():
        if k == "password":
            print(f"{k}: {'*' * len(v) if v else 'None'}")
        else:
            print(f"{k}: {v}")

    connection = None
    try:
        connection = mysql.connector.connect(**db_config)
        if connection.is_connected():
            print("Successfully connected to MySQL database!")
            cursor = connection.cursor()
            cursor.execute("SELECT VERSION()")
            db_version = cursor.fetchone()
            print(f"Database version: {db_version[0]}")
            cursor.close()
        else:
            print("Failed to connect to MySQL database.")
    except mysql.connector.Error as err:
        print(f"Error: {err}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
    finally:
        if connection and connection.is_connected():
            connection.close()
            print("MySQL connection closed.")

if __name__ == "__main__":
    test_db_connection()
