import { type NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from 'uuid';
import { logEvent } from "@/lib/log";
import { logSyncEvent } from "@/lib/sync";
import { z } from "zod"; // Import zod

// Define schema for a single bill item
const billItemSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  name: z.string().min(1, "Product name is required"),
  quantity: z.number().int().positive("Quantity must be a positive integer"),
  price: z.number().positive("Price must be a positive number"),
  total: z.number().positive("Total must be a positive number"),
  tax: z.number().min(0).optional().default(0.00),
  gstRate: z.number().min(0).optional().default(0.00),
  barcodes: z.array(z.string()).optional().nullable(),
});

// Define schema for the entire invoice request
const invoiceSchema = z.object({
  id: z.string().optional(), // Allow id to be present, though it's generated server-side
  items: z.array(billItemSchema).min(1, "At least one item is required"),
  storeId: z.string().min(1, "Store ID is required"),
  storeName: z.string().min(1, "Store name is required"),
  storeAddress: z.string().optional().nullable(),
  customerName: z.string().optional().nullable(),
  customerPhone: z.string().optional().nullable(),
  customerEmail: z.string().email("Invalid email address").optional().nullable(),
  customerAddress: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  subtotal: z.number().positive("Subtotal must be a positive number"),
  taxPercentage: z.number().min(0).max(100).optional().default(0),
  taxAmount: z.number().min(0).optional().default(0),
  discountPercentage: z.number().min(0).max(100).optional().default(0),
  discountAmount: z.number().min(0).optional().default(0),
  total: z.number().positive("Total must be a positive number"),
  paymentMethod: z.string().min(1, "Payment method is required"),
  timestamp: z.string().datetime().optional().transform((str) => str ? new Date(str) : new Date()),
  notes: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  companyName: z.string().optional().nullable(),
  companyAddress: z.string().optional().nullable(),
  companyPhone: z.string().optional().nullable(),
  companyEmail: z.string().email("Invalid email address").optional().nullable(),
  billFormat: z.string().optional().nullable(),
  userId: z.string().min(1, "User ID is required"), // Assuming userId is always passed
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate the request body
    const validationResult = invoiceSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const invoiceRequest = validationResult.data;
    const { items, ...billData } = invoiceRequest;

    // Generate a unique ID for the bill on the server side
    const newBillId = `INV-${uuidv4()}`;
    billData.id = newBillId; // Assign the new unique ID to billData

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      if (!billData.customerId) {
        const walkinCustomerId = `CUST-${Date.now()}`;
        const newCustomer = {
          id: walkinCustomerId,
          name: billData.customerName || "Walk-in Customer",
          phone: billData.customerPhone || null,
          email: billData.customerEmail || null,
          address: billData.customerAddress || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        
        let customerIdToUse = walkinCustomerId;

        if (billData.customerPhone) {
          const [existingCustomers] = await connection.query("SELECT id FROM Customers WHERE phone = ?", [billData.customerPhone]);
          if (Array.isArray(existingCustomers) && existingCustomers.length > 0) {
            // @ts-ignore
            customerIdToUse = existingCustomers[0].id;
          } else {
             await connection.query("INSERT INTO Customers SET ?", newCustomer);
          }
        } else {
            // For walk-in customers without a phone number, we'll check for a generic walk-in
            const [walkin] = await connection.query("SELECT id FROM Customers WHERE name = 'Walk-in Customer' AND phone IS NULL");
            if (Array.isArray(walkin) && walkin.length > 0) {
                // @ts-ignore
                customerIdToUse = walkin[0].id;
            } else {
                await connection.query("INSERT INTO Customers SET ?", newCustomer);
            }
        }
        billData.customerId = customerIdToUse;
      }

      // Prepare bill data for insertion into the Bills table
      const billToInsert = {
        id: billData.id, // Use the newly generated unique ID
        storeId: billData.storeId,
        storeName: billData.storeName,
        storeAddress: billData.storeAddress,
        customerName: billData.customerName,
        customerPhone: billData.customerPhone,
        customerEmail: billData.customerEmail,
        customerAddress: billData.customerAddress,
        customerId: billData.customerId,
        subtotal: billData.subtotal,
        taxPercentage: billData.taxPercentage,
        taxAmount: billData.taxAmount,
        discountPercentage: billData.discountPercentage,
        discountAmount: billData.discountAmount,
        total: billData.total,
        paymentMethod: billData.paymentMethod,
        timestamp: billData.timestamp || new Date(), // Use provided timestamp or current date
        notes: billData.notes,
        gstin: billData.gstin,
        companyName: billData.companyName,
        companyAddress: billData.companyAddress,
        companyPhone: billData.companyPhone,
        companyEmail: billData.companyEmail,
        billFormat: billData.billFormat,
        createdBy: billData.userId, // Assuming userId is passed in billData
      };

      await connection.query("INSERT INTO Bills SET ?", billToInsert);

      const itemInsertPromises = items.map((item: any) => {
        // Extract relevant fields for BillItems table
        const billItemToInsert = {
          billId: billData.id, // Use the newly generated unique ID
          productId: item.productId,
          productName: item.name, // Using 'name' from item as productName
          quantity: item.quantity,
          price: item.price,
          total: item.total,
          tax: item.tax || 0.00, // Add tax field
          gstRate: item.gstRate || 0.00, // Add gstRate field
          barcodes: item.barcodes ? JSON.stringify(item.barcodes) : null, // Add barcodes field, stringify if array
        };
        return connection.query("INSERT INTO BillItems SET ?", billItemToInsert);
      });

      await Promise.all(itemInsertPromises);

      // Update stock in the database
      const stockUpdatePromises = items.map((item: any) => {
        return connection.query(
          "UPDATE Products SET stock = stock - ? WHERE id = ?",
          [item.quantity, item.productId]
        );
      });

      await Promise.all(stockUpdatePromises);

      await connection.commit();
      // Assuming billData contains a userId or similar identifier for the user who created the bill
      // If not, you might need to extract it from the request headers or session
      if (billData.userId) {
        await logEvent("BILL_CREATED", billData.userId, { billId: billData.id, totalAmount: billData.total });
        await logSyncEvent("BILL_CREATED", { billId: billData.id, userId: billData.userId, totalAmount: billData.total });
      } else {
        console.warn("Bill created, but no userId found in billData to log the event.");
        await logEvent("BILL_CREATED", "UNKNOWN_USER", { billId: billData.id, totalAmount: billData.total });
        await logSyncEvent("BILL_CREATED", { billId: billData.id, userId: "UNKNOWN_USER", totalAmount: billData.total });
      }
      connection.release();

      // Create the final invoice object to save to JSON
      const finalInvoice = { ...billData, items };

      // Save to JSON file
      const filePath = path.join(process.cwd(), "data", "json", "bill.json");
      let allBills = [];
      try {
        const fileContent = await fs.readFile(filePath, "utf-8");
        allBills = JSON.parse(fileContent);
      } catch (error) {
        // File might not exist, which is fine
      }
      allBills.push(finalInvoice);
      await fs.writeFile(filePath, JSON.stringify(allBills, null, 2));

      // Update stock in products.json
      const productsFilePath = path.join(process.cwd(), "data", "json", "products.json");
      let products = [];
      try {
        const productsFileContent = await fs.readFile(productsFilePath, "utf-8");
        products = JSON.parse(productsFileContent);
      } catch (error) {
        // File might not exist, which is fine
      }

      items.forEach((item: any) => {
        const productIndex = products.findIndex((p: any) => p.id === item.productId);
        if (productIndex !== -1) {
          products[productIndex].stock -= item.quantity;
        }
      });

      await fs.writeFile(productsFilePath, JSON.stringify(products, null, 2));

      return NextResponse.json({ success: true });
    } catch (error) {
      await connection.rollback();
      connection.release();
      throw error;
    }
  } catch (error) {
    console.error("Failed to save invoice:", error);
    return NextResponse.json(
      { error: "Failed to save invoice" },
      { status: 500 }
    );
  }
}
