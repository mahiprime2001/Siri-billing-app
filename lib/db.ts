import mysql from 'mysql2/promise';
import { showToast } from '../components/ui/use-toast';

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: '86.38.243.155',
      port: 3306,
      user: 'u408450631_siri',
      password: 'Siriart@2025',
      database: 'u408450631_siri',
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
