import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod'; // Import zod

const productsFilePath = path.join(process.cwd(), 'data', 'json', 'products.json');

// Define schema for a single product
const productSchema = z.object({
  id: z.string().optional(), // ID can be generated if missing
  name: z.string().min(1, "Product name is required"),
  description: z.string().optional().nullable(),
  price: z.number().positive("Price must be a positive number"),
  stock: z.number().int().min(0, "Stock cannot be negative"),
  category: z.string().optional().nullable(),
  imageUrl: z.string().url("Invalid image URL").optional().nullable(),
  barcode: z.string().optional().nullable(),
  gstRate: z.number().min(0).max(100).optional().default(0),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

// Define schema for the array of products
const productsUploadSchema = z.array(productSchema);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Validate the request body
    const validationResult = productsUploadSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const newProducts = validationResult.data;

    // Read existing products
    let existingProducts: any[] = [];
    try {
      const data = await fs.readFile(productsFilePath, 'utf8');
      existingProducts = JSON.parse(data);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File does not exist, start with an empty array
        existingProducts = [];
      } else {
        console.error('Error reading products.json:', error);
        return NextResponse.json({ error: 'Failed to read existing products data.' }, { status: 500 });
      }
    }

    // Merge new products with existing ones
    const updatedProductsMap = new Map(existingProducts.map(p => [p.id, p]));
    newProducts.forEach(newProduct => {
      // Ensure product has an ID, generate if missing
      if (!newProduct.id) {
        newProduct.id = Date.now().toString(); // Simple ID generation
      }
      // Add or update product
      updatedProductsMap.set(newProduct.id, {
        ...newProduct,
        createdAt: newProduct.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    const finalProducts = Array.from(updatedProductsMap.values());

    // Write updated products back to the file
    await fs.writeFile(productsFilePath, JSON.stringify(finalProducts, null, 2), 'utf8');

    return NextResponse.json({ message: 'Products uploaded successfully!' }, { status: 200 });
  } catch (error: any) {
    console.error('Error uploading products:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
