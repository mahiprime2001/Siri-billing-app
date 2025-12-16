declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

interface Invoice {
  id: string;
  storeId: string;
  customerId: string;
  userId: string;
  subtotal: number;
  taxPercentage: number;
  taxAmount: number;
  discountPercentage: number;
  discountAmount: number;
  total: number;
  paymentMethod: string;
  timestamp: string;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
  gstin: string;
  billFormat: string;
  items: any[];

  // Optional fields from billing-history
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
  companyName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;

  // Optional nested objects from billing-history
  customers?: {
    name: string;
    phone: string;
    email: string;
    address: string;
  };
  stores?: {
    name: string;
    address: string;
    phone: string;
  };
}