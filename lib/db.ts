import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { showToast } from '../components/ui/use-toast';

dotenv.config(); // Load environment variables at the module level

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

export async function checkDbConnection(isOnline: boolean) {
  if (!isOnline) {
    console.log('Not online, skipping database connection check.');
    showToast({
      title: 'No Internet Connection',
      description: 'Please check your internet connection before attempting to connect to the database.',
      variant: 'destructive',
    });
    return false;
  }

  try {
    const connection = await getPool().getConnection();
    connection.release();
    console.log('Database connection successful.');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    showToast({
      title: 'Database Connection Error',
      description: 'Could not connect to the database. Please check your internet connection and database server.',
      variant: 'destructive',
    });
    return false;
  }
}

export default getPool;
