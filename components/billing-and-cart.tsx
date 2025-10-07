"use client"

import type React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Plus,
  Trash2,
  X,
  ShoppingCart,
  Percent,
  Search,
  ScanLine,
  FileText,
  User,
  Package,
  Receipt,
  CreditCard,
  Store as StoreIcon,
  UploadCloud,
} from "lucide-react"
import InvoicePreview from "./invoice-preview"
import { useRouter } from "next/navigation"
import { useToast } from "@/components/ui/use-toast"
import { LogOut } from "lucide-react"
import { useOnlineStatus } from "@/hooks/use-online-status"

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Store {
  id: string;
  name: string;
  address: string;
}

interface UserStore {
  userId: string;
  storeId: string;
}

interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  tax: number;
  createdAt: string;
  updatedAt: string;
  barcodes?: string;
}

interface CartItem {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  price: number;
  total: number;
  tax: number;
  gstRate: number;
  barcodes?: string;
}

interface Settings {
  id: number;
  gstin: string;
  taxPercentage: number;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
}

interface Invoice {
  id: string;
  storeId: string;
  storeName: string;
  storeAddress: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  customerId: string;
  subtotal: number;
  taxPercentage: number;
  taxAmount: number;
  discountPercentage: number;
  discountAmount: number;
  total: number;
  paymentMethod: string;
  timestamp: string;
  notes: string;
  gstin: string;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  billFormat: string;
  createdBy: string;
  items: any[]; // You might want to define a proper type for items
}

interface BillingInstance {
  id: string
  cartItems: CartItem[]
  customerName: string
  customerPhone: string
  discount: number
  editableTotal: number
  isEditingTotal: boolean
  paymentMethod: string
}

const SUGGESTED_DISCOUNTS = [5, 10, 15, 20]
const DEFAULT_GST_RATE = 0

const createNewBillingInstance = (id: string): BillingInstance => ({
  id,
  cartItems: [],
  customerName: "",
  customerPhone: "",
  discount: 0,
  editableTotal: 0,
  isEditingTotal: false,
  paymentMethod: "Cash",
})

export default function BillingAndCart() {
  const router = useRouter()
  const { toast } = useToast()
  const isOnline = useOnlineStatus() // Get online status
  const [products, setProducts] = useState<Product[]>([])
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [searchTerm, setSearchTerm] = useState("")
  const [barcodeInput, setBarcodeInput] = useState("")
  const [isScanning, setIsScanning] = useState(false)
  const [showAllProducts, setShowAllProducts] = useState(false)
  const [paperSize, setPaperSize] = useState("Thermal 80mm")

  const [users, setUsers] = useState<User[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [userStores, setUserStores] = useState<UserStore[]>([])
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [currentStore, setCurrentStore] = useState<Store | null>(null)

  const [billingTabs, setBillingTabs] = useState<BillingInstance[]>([createNewBillingInstance("bill-1")])
  const [activeTab, setActiveTab] = useState<string>("bill-1")

  // Invoice preview
  const [showPreview, setShowPreview] = useState(false)
  const [currentInvoice, setCurrentInvoice] = useState<Invoice | null>(null)

  const barcodeInputRef = useRef<HTMLInputElement>(null)

  const activeBillingInstance = billingTabs.find((tab) => tab.id === activeTab)

  const calculateSubtotal = useCallback(() => {
    if (!activeBillingInstance) return 0
    const subtotal = activeBillingInstance.cartItems.reduce((sum, item) => sum + item.total, 0)
    return Math.round(subtotal * 100) / 100 // Round to 2 decimal places
  }, [activeBillingInstance])

  const calculateDiscountAmount = useCallback(() => {
    if (!activeBillingInstance) return 0
    const subtotal = calculateSubtotal()
    const discountAmount = (subtotal * activeBillingInstance.discount) / 100
    return Math.round(discountAmount * 100) / 100 // Round to 2 decimal places
  }, [activeBillingInstance, calculateSubtotal])

  const calculateTaxableAmount = useCallback(() => {
    const taxableAmount = calculateSubtotal() - calculateDiscountAmount()
    return Math.round(taxableAmount * 100) / 100 // Round to 2 decimal places
  }, [calculateSubtotal, calculateDiscountAmount])

  const calculateTaxAmount = useCallback(() => {
    if (!settings) return 0
    const taxableAmount = calculateTaxableAmount()
    const taxAmount = (taxableAmount * (settings.taxPercentage || 0)) / 100
    return Math.round(taxAmount * 100) / 100 // Round to 2 decimal places
  }, [settings, calculateTaxableAmount])

  const calculateFinalTotal = useCallback(() => {
    const finalTotal = calculateTaxableAmount() + calculateTaxAmount()
    return Math.round(finalTotal * 100) / 100 // Round to 2 decimal places
  }, [calculateTaxableAmount, calculateTaxAmount])

  useEffect(() => {
    fetchProducts()
    fetchSettings()
    fetchUserData()
  }, [isOnline])

  // Effect to set the initial user
  useEffect(() => {
    const loggedInUserEmail = localStorage.getItem("userEmail");
    console.log("loggedInUserEmail from localStorage:", loggedInUserEmail);
    console.log("Users array:", users);
    console.log("Current user state:", currentUser);

    if (users.length > 0 && !currentUser && loggedInUserEmail) {
      const match = users.find(
        (u) => u.email.toLowerCase() === loggedInUserEmail.toLowerCase()
      );
      console.log("Found matching user:", match);
      if (match) {
        setCurrentUser(match);
      }
    }
  }, [users, currentUser]);

  // Effect to set the store based on the current user
  useEffect(() => {
    if (currentUser && stores && userStores && stores.length > 0 && userStores.length > 0) {
      const userStoreMapping = userStores.find(us => us.userId === currentUser.id);
      if (userStoreMapping) {
        const assignedStore = stores.find(s => s.id === userStoreMapping.storeId);
        if (assignedStore) {
          setCurrentStore(assignedStore);
        }
      }
    }
  }, [currentUser, stores, userStores]);

  const handleLogout = () => {
    localStorage.removeItem("user")
    localStorage.removeItem("userEmail")
    toast({
      title: "Logout Successful",
      description: "You have been successfully logged out.",
      variant: "default",
    })
    router.push("/login")
  }

  useEffect(() => {
    if (activeBillingInstance && !activeBillingInstance.isEditingTotal) {
      updateBillingInstance(activeTab, {
        editableTotal: Math.round(calculateFinalTotal()),
      })
    }
  }, [activeBillingInstance?.cartItems, activeBillingInstance?.discount, activeBillingInstance?.isEditingTotal, settings])

  useEffect(() => {
    if (searchTerm.trim() === "") {
      setFilteredProducts(showAllProducts ? products : [])
    } else {
      const filtered = products.filter(
        (product) =>
          product.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (product.barcodes && product.barcodes.includes(searchTerm)),
      )
      setFilteredProducts(filtered)
    }
  }, [searchTerm, products, showAllProducts])

  const updateBillingInstance = (tabId: string, updates: Partial<BillingInstance>) => {
    setBillingTabs((prevTabs) =>
      prevTabs.map((tab) => (tab.id === tabId ? { ...tab, ...updates } : tab)),
    )
  }


  const fetchProducts = async () => {
    try {
      const response = await fetch("http://localhost:8080/api/products")
      const data = await response.json()
      console.log("Fetched products:", data); // Log fetched products
      setProducts(data)
      setFilteredProducts([])
    } catch (error) {
      console.error("Error fetching products:", error)
      toast({
        title: "Network Error",
        description: "Failed to fetch products from server. Check your connection.",
        variant: "destructive",
      })
    }
  }

  const fetchSettings = async () => {
    try {
      const response = await fetch("http://localhost:8080/api/settings")
      let data = await response.json()
      if (Array.isArray(data) && data.length > 0) {
        data = data[0]
      }
      if (data && data.taxPercentage) {
        data.taxPercentage = parseFloat(data.taxPercentage)
      }
      setSettings(data)
    } catch (error) {
      console.error("Error fetching settings:", error)
      toast({
        title: "Network Error",
        description: "Failed to fetch settings from server. Check your connection.",
        variant: "destructive",
      })
    }
  }

  const fetchUserData = async () => {
    try {
      const [usersRes, storesRes, userStoresRes] = await Promise.all([
        fetch(`${process.env.NEXT_PUBLIC_BACKEND_API_URL}/api/users`),
        fetch(`${process.env.NEXT_PUBLIC_BACKEND_API_URL}/api/stores`),
        fetch(`${process.env.NEXT_PUBLIC_BACKEND_API_URL}/api/user-stores`),
      ]);
      const { users: usersData } = await usersRes.json();
      const { stores: storesData } = await storesRes.json();
      const userStoresData = await userStoresRes.json();
      setUsers(usersData);
      setStores(storesData);
      setUserStores(userStoresData);
    } catch (error) {
      console.error("Error fetching user data:", error);
      toast({
        title: "Network Error",
        description: "Failed to fetch user data from server. Check your connection.",
        variant: "destructive",
      })
    }
  };


  const addToCart = (productId: string, qty = 1) => {
    if (!activeBillingInstance) return
    const product = products.find((p) => p.id === productId)
    if (!product) return

    const existingItem = activeBillingInstance.cartItems.find((item) => item.productId === product.id)

    let updatedCartItems: CartItem[]
    if (existingItem) {
      updatedCartItems = activeBillingInstance.cartItems.map((item) =>
        item.productId === product.id
          ? { ...item, quantity: item.quantity + qty, total: (item.quantity + qty) * item.price }
          : item,
      )
    } else {
    const newItem: CartItem = {
      id: Date.now().toString(),
      productId: product.id,
      name: product.name,
      quantity: qty,
      price: Number(product.price),
      total: Math.round(Number(product.price) * qty * 100) / 100, // Round to 2 decimal places
      tax: Number(product.tax),
      gstRate: Number(product.tax),
      barcodes: product.barcodes,
    }
      updatedCartItems = [...activeBillingInstance.cartItems, newItem]
    }

    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
    setSearchTerm("")
    setShowAllProducts(false)
    toast({
      title: "Success",
      description: `${product.name} added to cart!`,
      variant: "default",
    })
  }

  const handleBarcodeSearch = () => {
    const trimmedBarcodeInput = barcodeInput.trim();
    console.log("handleBarcodeSearch called with input:", trimmedBarcodeInput);
    console.log("Current products state:", products);

    if (!trimmedBarcodeInput) return;

    const product = products.find((p) => {
      if (p.barcodes) {
        const productBarcodes = p.barcodes.split(',').map(b => b.trim());
        console.log(`Checking product ${p.name} (ID: ${p.id}) with barcodes:`, productBarcodes);
        return productBarcodes.includes(trimmedBarcodeInput);
      }
      return false;
    });

    if (product) {
      console.log("Product found:", product);
      addToCart(product.id, 1);
      setBarcodeInput("");
    } else {
      console.log("Product not found for barcode:", trimmedBarcodeInput);
      toast({
        title: "Error",
        description: "Product not found with this barcode.",
        variant: "destructive",
      })
    }
  };

  const handleBarcodeKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBarcodeSearch()
    }
  }

  const startBarcodeScanning = () => {
    setIsScanning(true)
    barcodeInputRef.current?.focus()
    toast({
      title: "Success",
      description: "Barcode scanner ready! Scan or type barcode and press Enter.",
      variant: "default",
    })
  }

  const removeFromCart = (id: string) => {
    if (!activeBillingInstance) return
    const updatedCartItems = activeBillingInstance.cartItems.filter((item) => item.id !== id)
    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
  }

  const updateQuantity = (id: string, newQuantity: number) => {
    if (!activeBillingInstance) return
    if (newQuantity <= 0) {
      removeFromCart(id)
      return
    }

    const updatedCartItems = activeBillingInstance.cartItems.map((item) =>
      item.id === id ? { ...item, quantity: newQuantity, total: Math.round(item.price * newQuantity * 100) / 100 } : item,
    )
    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
  }

  const handleTotalEdit = (newTotal: number) => {
    if (!activeBillingInstance) return
    updateBillingInstance(activeTab, { editableTotal: newTotal, isEditingTotal: true })

    const subtotal = calculateSubtotal()
    const currentTaxAmount = calculateTaxAmount()
    const targetTaxableAmount = newTotal - currentTaxAmount

    if (subtotal > 0) {
      const newDiscountAmount = subtotal - targetTaxableAmount
      const newDiscountPercentage = Math.max(0, (newDiscountAmount / subtotal) * 100)
      updateBillingInstance(activeTab, {
        discount: Math.round(newDiscountPercentage * 100) / 100,
      })
    }
  }

  const handleDiscountChange = (newDiscount: number) => {
    updateBillingInstance(activeTab, { discount: newDiscount, isEditingTotal: false })
  }

  const clearCart = () => {
    updateBillingInstance(activeTab, {
      cartItems: [],
      discount: 0,
      editableTotal: 0,
      isEditingTotal: false,
    })
  }

  const generateInvoiceId = () => {
    return `INV-${Date.now().toString().slice(-6)}`
  }

  const handlePreview = () => {
    if (!currentStore) {
      toast({
        title: "Error",
        description: "No store selected. Please select a store.",
        variant: "destructive",
      })
      return;
    }

    if (!activeBillingInstance || activeBillingInstance.cartItems.length === 0) {
      toast({
        title: "Error",
        description: "Please add at least one item to the cart.",
        variant: "destructive",
      })
      return
    }

    if (!settings) {
      toast({
        title: "Error",
        description: "Settings not loaded. Please try again.",
        variant: "destructive",
      })
      return
    }

    const invoice: Invoice = {
      id: generateInvoiceId(),
      storeId: currentStore?.id || "",
      storeName: currentStore?.name || "N/A",
      storeAddress: currentStore?.address || "N/A",
      customerName: activeBillingInstance.customerName || "Walk-in Customer",
      customerEmail: "",
      customerPhone: activeBillingInstance.customerPhone || "",
      customerAddress: "",
      customerId: "",
      subtotal: calculateSubtotal(),
      taxPercentage: settings?.taxPercentage || 0,
      taxAmount: calculateTaxAmount(),
      discountPercentage: activeBillingInstance.discount,
      discountAmount: calculateDiscountAmount(),
      total: activeBillingInstance.editableTotal,
      paymentMethod: activeBillingInstance.paymentMethod,
      timestamp: new Date().toISOString(),
      notes: "",
      gstin: settings?.gstin || "",
      companyName: settings?.companyName || "",
      companyAddress: settings?.companyAddress || "",
      companyPhone: settings?.companyPhone || "",
      companyEmail: settings?.companyEmail || "",
      billFormat: "Thermal 80mm",
      createdBy: currentUser?.id || "",
      items: activeBillingInstance.cartItems,
    };
    setCurrentInvoice(invoice)
    setShowPreview(true)
  }

  const handleSaveInvoice = async (invoice: Invoice, isReplay = false) => {
    // If offline, we cannot save to the Flask backend.
    // The user's instruction is to use the Flask server for ALL functions,
    // implying no offline local storage. Therefore, if offline, we will
    // simply show an error and prevent saving.
    if (!isOnline) {
      toast({
        title: "Error",
        description: "Cannot save invoice while offline. Please connect to the internet.",
        variant: "destructive",
      })
      return false;
    }

    try {
      const response = await fetch("http://localhost:8080/api/billing/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invoice),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Invoice ${isReplay ? "synced" : "saved"} successfully!`,
          variant: "default",
        })
        // Reset the current tab only if it's not a replay (replay doesn't affect current UI state)
        if (!isReplay) {
          const newId = `bill-${Date.now()}`
          const newTabs = billingTabs.map((tab) =>
            tab.id === activeTab ? createNewBillingInstance(newId) : tab,
          )
          setBillingTabs(newTabs)
          setActiveTab(newId)
          setShowPreview(false)
        }
        return true
      } else {
        const errorData = await response.json();
        toast({
          title: "Error",
          description: `Failed to save invoice: ${errorData.error || response.statusText}`,
          variant: "destructive",
        })
        return false
      }
    } catch (error) {
      console.error("Error saving invoice:", error);
      toast({
        title: "Error",
        description: "An error occurred while saving the invoice.",
        variant: "destructive",
      })
      return false
    }
  }

  const handlePrintAndSave = async (invoice: Invoice) => {
    const saved = await handleSaveInvoice(invoice)
    if (saved) {
      // window.print() call removed as per user request.
      // Printing functionality is now expected to be handled by the InvoicePreview component.
    }
  }

  const handleSearchFocus = () => {
    if (searchTerm.trim() === "") {
      setShowAllProducts(true)
    }
  }

  const handleSearchBlur = () => {
    setTimeout(() => {
      setShowAllProducts(false)
    }, 200)
  }

  const addTab = () => {
    const newTabId = `bill-${Date.now()}`
    setBillingTabs([...billingTabs, createNewBillingInstance(newTabId)])
    setActiveTab(newTabId)
  }

  const closeTab = (tabId: string) => {
    if (billingTabs.length === 1) return // Prevent closing the last tab

    const tabIndex = billingTabs.findIndex((tab) => tab.id === tabId)
    const newTabs = billingTabs.filter((tab) => tab.id !== tabId)
    setBillingTabs(newTabs)

    if (activeTab === tabId) {
      const newActiveIndex = Math.max(0, tabIndex - 1)
      setActiveTab(newTabs[newActiveIndex].id)
    }
  }

  if (!activeBillingInstance) {
    return <div>Loading...</div> // Or some other placeholder
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      toast({
        title: "Error",
        description: "No file selected.",
        variant: "destructive",
      })
      return;
    }

    if (file.type !== "application/json") {
      toast({
        title: "Error",
        description: "Please upload a JSON file.",
        variant: "destructive",
      })
      return;
    }

    try {
      const fileContent = await file.text();
      const jsonData = JSON.parse(fileContent);

      const response = await fetch("http://localhost:8080/api/products/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(jsonData),
      });

      if (response.ok) {
        toast({
          title: "Success",
          description: "Products uploaded successfully!",
          variant: "default",
        })
        fetchProducts(); // Refresh product list
      } else {
        const errorData = await response.json();
        toast({
          title: "Error",
          description: `Failed to upload products: ${errorData.error}`,
          variant: "destructive",
        })
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: `Error processing file: ${error.message}`,
        variant: "destructive",
      })
    } finally {
      event.target.value = ""; // Clear the file input
    }
  };

  console.log({ currentStore });

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column - Product Search & Barcode Scanner */}
        <div className="space-y-6">
          {/* Barcode Scanner */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <ScanLine className="h-5 w-5 mr-2" />
                Barcode Scanner
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex space-x-2">
                <Input
                  ref={barcodeInputRef}
                  placeholder="Scan or enter barcode/product ID"
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  onKeyPress={handleBarcodeKeyPress}
                  className={isScanning ? "border-green-500 bg-green-50" : ""}
                />
                <Button onClick={startBarcodeScanning} variant="outline">
                  <ScanLine className="h-4 w-4 mr-2" />
                  Scan
                </Button>
              </div>
              {isScanning && <p className="text-sm text-green-600">Scanner active - scan barcode or type manually</p>}
            </CardContent>
          </Card>

          {/* Product Search */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Package className="h-5 w-5 mr-2" />
                Product Search
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <Input
                  placeholder="Search products or click to see all..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onFocus={handleSearchFocus}
                  onBlur={handleSearchBlur}
                  className="pl-10"
                />
              </div>

              {/* Upload Products Button */}
              <div className="flex items-center space-x-2">
                <Input
                  id="json-upload"
                  type="file"
                  accept=".json"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Label htmlFor="json-upload" className="w-full">
                  <Button asChild className="w-full">
                    <span>
                      <UploadCloud className="h-4 w-4 mr-2" />
                      Upload Products (JSON)
                    </span>
                  </Button>
                </Label>
              </div>

              <div className="max-h-96 overflow-y-auto border rounded-md">
                {(searchTerm.trim() ? filteredProducts : products).map((product) => (
                  <div
                    key={product.id}
                    className="p-3 hover:bg-gray-50 cursor-pointer border-b last:border-b-0 flex justify-between items-center"
                    onClick={() => addToCart(product.id, 1)}
                  >
                    <div>
                      <p className="font-medium">{product.name}</p>
                      <p className="text-sm text-gray-500">
                        Stock: {product.stock} • Tax: {product.tax}%
                        {product.barcodes && ` • ${product.barcodes.split(',')[0]}${product.barcodes.split(',').length > 1 ? '...' : ''}`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">₹{product.price.toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Customer Info, Cart & Billing */}
        <div className="space-y-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <div className="flex items-center">
              <TabsList>
                {billingTabs.map((tab, index) => (
                  <TabsTrigger key={tab.id} value={tab.id} className="relative pr-7">
                    Bill {index + 1}
                    {billingTabs.length > 1 && (
                      <span
                        className="absolute top-1/2 right-1 transform -translate-y-1/2 rounded-full p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700"
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTab(tab.id)
                        }}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
              <Button onClick={addTab} size="sm" variant="outline" className="ml-2">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {billingTabs.map((tab) => (
              <TabsContent key={tab.id} value={tab.id} className="mt-4">
                {/* Store Information */}
                {currentStore && (
                  <Card className="mb-6">
                    <CardHeader>
                      <CardTitle className="flex items-center">
                        <StoreIcon className="h-5 w-5 mr-2" />
                        Store Information
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="font-semibold">{currentStore.name}</p>
                      <p className="text-sm text-gray-500">{currentStore.address}</p>
                      {currentUser && (
                        <div className="flex items-center justify-between mt-2">
                          <p className="text-sm text-gray-500">
                            Logged in as: <span className="font-medium">{currentUser.name}</span> ({currentUser.role})
                          </p>
                          <Button variant="outline" size="sm" onClick={handleLogout}>
                            <LogOut className="h-4 w-4 mr-2" />
                            Logout
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Customer Information */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center">
                      <User className="h-5 w-5 mr-2" />
                      Customer Information (Optional)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor={`customerName-${tab.id}`}>Customer Name</Label>
                        <Input
                          id={`customerName-${tab.id}`}
                          name="customerName"
                          value={tab.customerName}
                          onChange={(e) => updateBillingInstance(tab.id, { customerName: e.target.value })}
                          placeholder="Enter customer name (optional)"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`customerPhone-${tab.id}`}>Customer Phone</Label>
                        <Input
                          id={`customerPhone-${tab.id}`}
                          name="customerPhone"
                          value={tab.customerPhone}
                          onChange={(e) => updateBillingInstance(tab.id, { customerPhone: e.target.value })}
                          placeholder="Enter customer phone (optional)"
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Shopping Cart */}
                <Card className="mt-6">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <div className="flex items-center">
                        <ShoppingCart className="h-5 w-5 mr-2" />
                        Shopping Cart ({tab.cartItems.length} items)
                      </div>
                      {tab.cartItems.length > 0 && (
                        <Button variant="outline" size="sm" onClick={clearCart}>
                          Clear All
                        </Button>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {tab.cartItems.length > 0 ? (
                      <div className="space-y-4">
                        <div className="max-h-60 overflow-y-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Item</TableHead>
                                <TableHead>Price</TableHead>
                                <TableHead>Qty</TableHead>
                                <TableHead>Tax%</TableHead>
                                <TableHead>Total</TableHead>
                                <TableHead></TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {tab.cartItems.map((item) => (
                                <TableRow key={item.id}>
                                  <TableCell className="font-medium">{item.name}</TableCell>
                                  <TableCell>₹{item.price.toLocaleString()}</TableCell>
                                  <TableCell>
                                    <div className="flex items-center space-x-2">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => updateQuantity(item.id, item.quantity - 1)}
                                      >
                                        -
                                      </Button>
                                      <span>{item.quantity}</span>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => updateQuantity(item.id, item.quantity + 1)}
                                      >
                                        +
                                      </Button>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="secondary">{item.tax}%</Badge>
                                  </TableCell>
                                  <TableCell>₹{item.total.toLocaleString()}</TableCell>
                                  <TableCell>
                                    <Button variant="outline" size="sm" onClick={() => removeFromCart(item.id)}>
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-8 text-gray-500">
                        <ShoppingCart className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>Cart is empty</p>
                        <p className="text-sm">Search or scan products to add them</p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Discount & Billing */}
                {tab.cartItems.length > 0 && (
                  <>
                    <Card className="mt-6">
                      <CardHeader>
                        <CardTitle className="flex items-center">
                          <Percent className="h-5 w-5 mr-2" />
                          Discount & Pricing
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {/* Quick Discount Buttons */}
                        <div className="space-y-2">
                          <Label>Quick Discount Options</Label>
                          <div className="flex flex-wrap gap-2">
                            {SUGGESTED_DISCOUNTS.map((suggestedDiscount) => (
                              <Button
                                key={suggestedDiscount}
                                variant={tab.discount === suggestedDiscount ? "default" : "outline"}
                                size="sm"
                                onClick={() => handleDiscountChange(suggestedDiscount)}
                              >
                                {suggestedDiscount}%
                              </Button>
                            ))}
                            <Button
                              variant={tab.discount === 0 ? "default" : "outline"}
                              size="sm"
                              onClick={() => handleDiscountChange(0)}
                            >
                              No Discount
                            </Button>
                          </div>
                        </div>

                        {/* Custom Discount & Editable Total */}
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor={`customDiscount-${tab.id}`}>Custom Discount (%)</Label>
                            <Input
                              id={`customDiscount-${tab.id}`}
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={isNaN(tab.discount) ? "" : tab.discount}
                              onChange={(e) => handleDiscountChange(Number.parseFloat(e.target.value) || 0)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor={`editableTotal-${tab.id}`}>Editable Total (₹)</Label>
                            <Input
                              id={`editableTotal-${tab.id}`}
                              type="number"
                              min="0"
                              step="0.01"
                              value={isNaN(tab.editableTotal) ? "" : tab.editableTotal}
                              onChange={(e) => handleTotalEdit(Number.parseFloat(e.target.value) || 0)}
                            />
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Billing Summary */}
                    <Card className="mt-6 bg-gradient-to-r from-amber-50 to-orange-50">
                      <CardHeader>
                        <CardTitle className="flex items-center">
                          <Receipt className="h-5 w-5 mr-2" />
                          Tax Invoice Summary
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          <div className="flex justify-between text-lg">
                            <span>Subtotal:</span>
                            <span>₹{calculateSubtotal().toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between text-lg">
                            <span>Discount ({tab.discount.toFixed(2)}%):</span>
                            <span className="text-green-600">-₹{calculateDiscountAmount().toLocaleString()}</span>
                          </div>

                          <div className="flex justify-between text-lg">
                            <span>
                              Tax ({settings?.taxPercentage || 0}%):
                            </span>
                            <span className="text-purple-600">+₹{calculateTaxAmount().toLocaleString()}</span>
                          </div>
                          <div className="border-t pt-3">
                            <div className="flex justify-between text-2xl font-bold">
                              <span>Final Total:</span>
                              <span>₹{tab.editableTotal.toLocaleString()}</span>
                            </div>
                          </div>
                          <div className="flex justify-between text-sm text-gray-600">
                            <span>Payment Method:</span>
                            <span className="flex items-center">
                              <CreditCard className="h-4 w-4 mr-1" />
                              {tab.paymentMethod}
                            </span>
                          </div>
                          {tab.discount > 0 && (
                            <div className="text-center">
                              <Badge variant="secondary" className="bg-green-100 text-green-800">
                                You saved ₹{calculateDiscountAmount().toLocaleString()}!
                              </Badge>
                            </div>
                          )}
                        </div>

                        {/* Invoice Settings & Actions */}
                        <div className="mt-6 space-y-4">
                          <div className="space-y-2">
                            <Label htmlFor={`paymentMethod-${tab.id}`}>Payment Method</Label>
                            <Select
                              value={tab.paymentMethod}
                              onValueChange={(value) => updateBillingInstance(tab.id, { paymentMethod: value })}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Cash">💵 Cash</SelectItem>
                                <SelectItem value="UPI">📱 UPI</SelectItem>
                                <SelectItem value="Card">💳 Card</SelectItem>
                                <SelectItem value="UPI+Cash">UPI+Cash</SelectItem>
                                <SelectItem value="Card+Cash">Card+Cash</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="paperSize">Paper Size</Label>
                            <Select value={paperSize} onValueChange={setPaperSize}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Thermal 80mm">Thermal 80mm</SelectItem>
                                <SelectItem value="Thermal 58mm">Thermal 58mm</SelectItem>
                                <SelectItem value="A4">A4</SelectItem>
                                <SelectItem value="Letter">Letter</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <Button
                            onClick={handlePreview}
                            disabled={tab.cartItems.length === 0 || !currentStore}
                            className="w-full"
                            size="lg"
                          >
                            <FileText className="h-4 w-4 mr-2" />
                            Generate Tax Invoice
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </div>

      {showPreview && currentInvoice && (
        <InvoicePreview
          invoice={currentInvoice}
          isOpen={showPreview}
          onClose={() => setShowPreview(false)}
          onSave={handleSaveInvoice ? () => handleSaveInvoice(currentInvoice) : undefined}
          onPrintAndSave={handlePrintAndSave ? () => handlePrintAndSave(currentInvoice) : undefined}
          paperSize={paperSize}
        />
      )}
    </>
  )
}
