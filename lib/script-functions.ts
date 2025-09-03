import getPool from './db';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

export async function extractAllData() {
    try {
        console.log('Starting data extraction...');
        const pool = getPool(); // Get the pool at runtime
        // 1. Extract Products and ProductBarcodes
        const [products] = await pool.query('SELECT * FROM Products');
        const [productBarcodes] = await pool.query('SELECT * FROM ProductBarcodes');
        const [billItems] = await pool.query('SELECT * FROM BillItems'); // Including BillItems as it's product-related transactional data
        const allProductsData = {
            products: products,
            productBarcodes: productBarcodes,
            billItems: billItems,
        };
        await fs.writeFile(path.join(process.cwd(), 'data/json/extracted_products.json'), JSON.stringify(allProductsData, null, 2));
        console.log('Extracted products data.');

        // 2. Extract BillFormats
        const [billFormats] = await pool.query('SELECT * FROM BillFormats');
        await fs.writeFile(path.join(process.cwd(), 'data/json/extracted_billformats.json'), JSON.stringify(billFormats, null, 2));
        console.log('Extracted billing formats.');

        // 3. Extract Stores
        const [stores] = await pool.query('SELECT * FROM Stores');
        await fs.writeFile(path.join(process.cwd(), 'data/json/extracted_stores.json'), JSON.stringify(stores, null, 2));
        console.log('Extracted stores data.');

        // 4. Extract Users (billing_users and temporary users, excluding super_admin)
        const [users] = await pool.query("SELECT id, name, email, role, status, createdAt, updatedAt FROM Users WHERE role IN ('billing_users', 'temporary_users') AND role != 'super_admin'");
        await fs.writeFile(path.join(process.cwd(), 'data/json/extracted_users.json'), JSON.stringify(users, null, 2));
        console.log('Extracted filtered users data.');

        console.log('Data extraction completed successfully.');
    } catch (error) {
        console.error('Error during data extraction:', error);
    }
}
