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
import { useIsMobile } from "@/hooks/use-mobile"
import { apiClient } from "@/lib/api-client"

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
  selling_price: number;
  stock: number;
  createdAt: string;
  updatedAt: string;
  barcodes?: string;
  tax: number;  // ✅ Tax percentage from products table
  hsn_code?: string;
  hsn_code_id?: number;
}

interface CartItem {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  price: number;  // This is the BASE price (without tax)
  sellingPrice: number;  // This is the original selling price (with tax)
  total: number;  // quantity * base price
  barcodes?: string;
  taxPercentage: number;  // Tax % for this product
  hsnCode?: string;
  hsn_code_id?: number;
}

interface Settings {
  id: number;
  gstin: string;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
}

interface BillingInstance {
  id: string
  cartItems: CartItem[]
  customerName: string
  customerPhone: string
  discount: number
  discountRequestId: string | null
  discountApprovalStatus: "not_required" | "pending" | "approved" | "denied"
  editableTotal: number
  isEditingTotal: boolean
  paymentMethod: string
}

const SUGGESTED_DISCOUNTS = [10]

const createNewBillingInstance = (id: string): BillingInstance => ({
  id,
  cartItems: [],
  customerName: "Walk-in Customer",
  customerPhone: "",
  discount: 0,
  discountRequestId: null,
  discountApprovalStatus: "not_required",
  editableTotal: 0,
  isEditingTotal: false,
  paymentMethod: "Cash",
})

export default function BillingAndCart() {
  const router = useRouter()
  const { toast } = useToast()
  const isOnline = useOnlineStatus()
  const isMobile = useIsMobile()
  const [products, setProducts] = useState<Product[]>([])
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [searchTerm, setSearchTerm] = useState("")
  const [barcodeInput, setBarcodeInput] = useState("")
  const [lastScanned, setLastScanned] = useState<Product | null>(null)
  const [showAllProducts, setShowAllProducts] = useState(false)
  const [isLoadingProducts, setIsLoadingProducts] = useState(false)

  const [users, setUsers] = useState<User[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [userStores, setUserStores] = useState<UserStore[]>([])
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [currentStore, setCurrentStore] = useState<Store | null>(null)

  const [billingTabs, setBillingTabs] = useState<BillingInstance[]>([createNewBillingInstance("bill-1")])
  const [activeTab, setActiveTab] = useState<string>("bill-1")

  const [showPreview, setShowPreview] = useState(false)
  const [currentInvoice, setCurrentInvoice] = useState<Invoice | null>(null)

  const barcodeInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    barcodeInputRef.current?.focus()
  }, [])

  const activeBillingInstance = billingTabs.find((tab) => tab.id === activeTab)
  const getProductById = useCallback((productId: string) => products.find((p) => p.id === productId), [products])
  const getAvailableStock = useCallback((productId: string) => getProductById(productId)?.stock ?? null, [getProductById])

  // ✅ Calculate base price from selling price (reverse calculation)
  const calculateBasePrice = (sellingPrice: number, taxPercentage: number): number => {
    // Formula: base_price = selling_price / (1 + tax_percentage/100)
    const basePrice = sellingPrice / (1 + taxPercentage / 100)
    return Math.round(basePrice * 100) / 100
  }

  const calculateSubtotal = useCallback(() => {
    if (!activeBillingInstance) return 0
    // Subtotal = sum of (base_price * quantity) for all items
    const subtotal = activeBillingInstance.cartItems.reduce((sum, item) => sum + item.total, 0)
    return Math.round(subtotal * 100) / 100
  }, [activeBillingInstance])

  const calculateDiscountAmount = useCallback(() => {
    if (!activeBillingInstance) return 0
    const subtotal = calculateSubtotal()
    const discountAmount = (subtotal * activeBillingInstance.discount) / 100
    return Math.round(discountAmount * 100) / 100
  }, [activeBillingInstance, calculateSubtotal])

  const calculateTaxableAmount = useCallback(() => {
    // Taxable amount = subtotal - discount
    const taxableAmount = calculateSubtotal() - calculateDiscountAmount()
    return Math.round(taxableAmount * 100) / 100
  }, [calculateSubtotal, calculateDiscountAmount])

  const calculateTotalTax = useCallback(() => {
    if (!activeBillingInstance) return { cgst: 0, sgst: 0, total: 0 }
    
    const taxableAmount = calculateTaxableAmount()
    
    // Calculate weighted average tax from all items
    let totalTaxAmount = 0
    
    activeBillingInstance.cartItems.forEach(item => {
      const itemTaxableAmount = item.total - (item.total * activeBillingInstance.discount / 100)
      const itemTaxAmount = (itemTaxableAmount * item.taxPercentage) / 100
      totalTaxAmount += itemTaxAmount
    })
    
    const cgst = totalTaxAmount / 2
    const sgst = totalTaxAmount / 2
    
    return {
      cgst: Math.round(cgst * 100) / 100,
      sgst: Math.round(sgst * 100) / 100,
      total: Math.round(totalTaxAmount * 100) / 100
    }
  }, [activeBillingInstance, calculateTaxableAmount])

  const calculateFinalTotal = useCallback(() => {
    const taxableAmount = calculateTaxableAmount()
    const tax = calculateTotalTax()
    const finalTotal = taxableAmount + tax.total
    return Math.round(finalTotal)  // ✅ Round to nearest integer
  }, [calculateTaxableAmount, calculateTotalTax])

  useEffect(() => {
    if (activeBillingInstance && !activeBillingInstance.isEditingTotal) {
      const finalTotal = calculateFinalTotal();
      if (finalTotal !== activeBillingInstance.editableTotal) {
        updateBillingInstance(activeTab, { editableTotal: finalTotal });
      }
    }
  }, [activeBillingInstance?.cartItems, activeBillingInstance?.discount, calculateFinalTotal, activeTab, activeBillingInstance?.isEditingTotal, activeBillingInstance?.editableTotal]);

  useEffect(() => {
    fetchProducts()
    fetchSettings()
    fetchUserData()
  }, [isOnline])

  useEffect(() => {
    const fetchCurrentUserAndStore = async () => {
      try {
        const userRes = await apiClient("/api/auth/me");
        
        if (!userRes.ok) {
          console.log("Failed to fetch user, layout will handle auth");
          return;
        }
        
        const userData = await userRes.json();
        const user = userData.user || userData;
        setCurrentUser(user);
        console.log('✅ User data loaded:', user);

        try {
          const storesRes = await apiClient("/api/stores");
          if (storesRes.ok) {
            const storesData = await storesRes.json();
            const storesArray = Array.isArray(storesData) ? storesData : storesData.stores || [];
            setStores(storesArray);
            console.log('✅ All stores loaded:', storesArray.length, 'stores');
          }
        } catch (err) {
          console.error("Failed to fetch stores:", err);
        }

        try {
          const userStoresRes = await apiClient("/api/user-stores");
          if (userStoresRes.ok) {
            const userStoresData = await userStoresRes.json();
            setUserStores(userStoresData);
            console.log('✅ User-stores loaded:', userStoresData.length, 'associations');
          }
        } catch (err) {
          console.error("Failed to fetch user stores:", err);
        }

        try {
          const currentStoreRes = await apiClient("/api/stores/current");
          if (currentStoreRes.ok) {
            const storeData = await currentStoreRes.json();
            setCurrentStore(storeData);
            console.log('✅ Current store loaded:', storeData.name, '(ID:', storeData.id + ')');
          } else if (currentStoreRes.status === 404) {
            console.warn('⚠️ No store assigned to user');
            setCurrentStore(null);
          }
        } catch (err) {
          console.error("Failed to fetch current store:", err);
        }

        fetchProducts();
        fetchSettings();

      } catch (error) {
        console.error("Error fetching current user or store:", error);
        console.log("Auth-related error caught, layout will manage state");
      }
    };

    fetchCurrentUserAndStore();
  }, [router]);

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

  const handleLogout = async () => {
    try {
      await apiClient("/api/auth/logout", { method: "POST" });
      localStorage.removeItem("session_token");
      toast({
        title: "Logout Successful",
        description: "You have been successfully logged out.",
        variant: "default",
      });
      router.push("/login");
    } catch (error) {
      console.error("Error during logout:", error);
      toast({
        title: "Logout Failed",
        description: "An error occurred during logout. Please try again.",
        variant: "destructive",
      });
    }
  };

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
      setIsLoadingProducts(true);
      const response = await apiClient("/api/products");
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      console.log("✅ Fetched store inventory products:", data.length, "items");
      console.log("📦 Sample product with tax:", data[0]);
      
      setProducts(data);
      setFilteredProducts([]);
    } catch (error) {
      console.error("❌ Error fetching store inventory products:", error);
      toast({
        title: "Network Error",
        description: "Failed to fetch store products. Check your connection.",
        variant: "destructive",
      });
      setProducts([]);
    } finally {
      setIsLoadingProducts(false);
    }
  };

  useEffect(() => {
    if (!currentStore) return

    const streamUrl = "http://localhost:8080/api/stock/stream"
    const source = new EventSource(streamUrl, { withCredentials: true })

    source.addEventListener("stock", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data || "{}")
        if (data.store_id && data.store_id !== currentStore.id) return
        fetchProducts()
      } catch (error) {
        console.error("❌ Failed to parse stock event:", error)
      }
    })

    source.addEventListener("error", (event) => {
      console.warn("⚠️ Stock stream disconnected:", event)
    })

    return () => {
      source.close()
    }
  }, [currentStore?.id])

  useEffect(() => {
    if (!activeBillingInstance) return

    let changed = false
    const reconciled = activeBillingInstance.cartItems.reduce<CartItem[]>((acc, item) => {
      const stock = getAvailableStock(item.productId)

      if (stock === null) {
        acc.push(item)
        return acc
      }

      if (stock <= 0) {
        changed = true
        return acc
      }

      const cappedQuantity = Math.min(item.quantity, stock)
      if (cappedQuantity !== item.quantity) {
        changed = true
        acc.push({
          ...item,
          quantity: cappedQuantity,
          total: Math.round(item.price * cappedQuantity * 100) / 100,
        })
        return acc
      }

      acc.push(item)
      return acc
    }, [])

    if (changed) {
      updateBillingInstance(activeTab, { cartItems: reconciled })
    }
  }, [activeBillingInstance?.cartItems, activeTab, getAvailableStock])

  const fetchSettings = async () => {
    try {
      console.log("⚙️ Fetching system settings...")
      const response = await apiClient("/api/settings")
      
      if (!response.ok) {
        throw new Error("Failed to fetch settings")
      }
      
      let data = await response.json()
      if (Array.isArray(data) && data.length > 0) {
        data = data[0]
      }
      
      console.log("✅ Settings loaded:", data)
      setSettings(data)
    } catch (error) {
      console.error("❌ Error fetching settings:", error)
      toast({
        title: "Settings Error",
        description: "Failed to load system settings",
        variant: "destructive",
      })
    }
  }

  const fetchUserData = async () => {
    try {
      const [usersRes, storesRes, userStoresRes] = await Promise.all([
        apiClient("/api/users"),
        apiClient("/api/stores"),
        apiClient("/api/user-stores"),
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
  }

  const addToCart = (productId: string, qty = 1) => {
    if (!activeBillingInstance) return
    const product = products.find((p) => p.id === productId)
    if (!product) return
    if (product.stock <= 0) {
      toast({
        title: "Out of Stock",
        description: `${product.name} is out of stock.`,
        variant: "destructive",
      })
      return
    }

    // ✅ Calculate base price (without tax)
    const basePrice = calculateBasePrice(product.selling_price, product.tax || 0)

    console.log("🛒 Adding to cart:", {
      product: product.name,
      sellingPrice: product.selling_price,
      tax: product.tax,
      basePrice: basePrice,
      quantity: qty
    })

    const existingItem = activeBillingInstance.cartItems.find((item) => item.productId === product.id)
    const currentQty = existingItem?.quantity ?? 0
    const maxAddable = product.stock - currentQty

    if (maxAddable <= 0) {
      toast({
        title: "Stock Limit Reached",
        description: `No more stock available for ${product.name}.`,
        variant: "destructive",
      })
      return
    }

    const finalQty = Math.min(qty, maxAddable)

    let updatedCartItems: CartItem[]
    if (existingItem) {
      console.log("📦 Item exists, updating quantity:", existingItem.quantity, "→", existingItem.quantity + finalQty)
      updatedCartItems = activeBillingInstance.cartItems.map((item) =>
        item.productId === product.id
          ? { 
              ...item, 
              quantity: item.quantity + finalQty, 
              total: (item.quantity + finalQty) * item.price 
            }
          : item,
      )
    } else {
      console.log("✨ New item added to cart")
      const newItem: CartItem = {
        id: Date.now().toString(),
        productId: product.id,
        name: product.name,
        quantity: finalQty,
        price: basePrice,  // Base price without tax
        sellingPrice: product.selling_price,  // Original selling price
        total: basePrice * finalQty,
        barcodes: product.barcodes?.split(',')[0] || '',
        taxPercentage: product.tax || 0,
        hsnCode: (product as any).hsnCode || product.hsn_code || "",
        hsn_code_id: product.hsn_code_id,
      }
      updatedCartItems = [...activeBillingInstance.cartItems, newItem]
    }

    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
    
    const adjustedMsg = finalQty < qty ? ` (added ${finalQty} due to stock)` : ""
    toast({
      title: "Added to Cart",
      description: `${product.name} x${finalQty}${adjustedMsg}`,
    })
  }

  const normalizeBarcode = (code: string) => {
    return code.trim().replace(/^0+/, "")
  }

  const handleBarcodeSearch = () => {
    const rawInput = barcodeInput.trim()
    if (!rawInput) return

    const input = normalizeBarcode(rawInput)

    const product = products.find((p) => {
      if (!p.barcodes) return false

      const productBarcodes = p.barcodes
        .split(",")
        .map((b) => normalizeBarcode(b))

      return productBarcodes.includes(input)
    })

    if (product) {
      addToCart(product.id, 1)
      setLastScanned(product)
      setBarcodeInput("")

      setTimeout(() => {
        barcodeInputRef.current?.focus()
      }, 0)
    } else {
      setBarcodeInput("")
      toast({
        title: "Not Found",
        description: `No product found for barcode: ${rawInput}`,
        variant: "destructive",
      })

      setTimeout(() => {
        barcodeInputRef.current?.focus()
      }, 0)
    }
  }

  const handleBarcodeKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleBarcodeSearch()
    }
  }

  const removeFromCart = (id: string) => {
    if (!activeBillingInstance) return
    const updatedCartItems = activeBillingInstance.cartItems.filter((item) => item.id !== id)
    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
  }

  const updateQuantity = (id: string, newQuantity: number) => {
    if (!activeBillingInstance) return
    const targetItem = activeBillingInstance.cartItems.find((item) => item.id === id)
    if (!targetItem) return
    const product = products.find((p) => p.id === targetItem.productId)

    if (product && product.stock <= 0) {
      removeFromCart(id)
      toast({
        title: "Out of Stock",
        description: `${targetItem.name} is now out of stock and was removed from the cart.`,
        variant: "destructive",
      })
      return
    }

    const cappedQuantity = product ? Math.min(newQuantity, product.stock) : newQuantity

    if (cappedQuantity <= 0) {
      removeFromCart(id)
      return
    }

    const updatedCartItems = activeBillingInstance.cartItems.map((item) =>
      item.id === id
        ? { ...item, quantity: cappedQuantity, total: Math.round(item.price * cappedQuantity * 100) / 100 }
        : item,
    )
    updateBillingInstance(activeTab, { cartItems: updatedCartItems })

    if (product && cappedQuantity !== newQuantity) {
      toast({
        title: "Stock Limited",
        description: `Only ${product.stock} left for ${product.name}.`,
        variant: "default",
      })
    }
  }

  const handleTotalEdit = (newTotal: number) => {
    if (!activeBillingInstance) return
    updateBillingInstance(activeTab, { editableTotal: newTotal, isEditingTotal: true })

    const subtotal = calculateSubtotal()
    const tax = calculateTotalTax()

    if (subtotal > 0) {
      const targetTaxableAmount = newTotal - tax.total
      const newDiscountAmount = subtotal - targetTaxableAmount
      const newDiscountPercentage = Math.min(100, Math.max(0, (newDiscountAmount / subtotal) * 100))
      updateBillingInstance(activeTab, {
        discount: Math.round(newDiscountPercentage * 100) / 100,
        discountRequestId: null,
        discountApprovalStatus: newDiscountPercentage > 10 ? "pending" : "not_required",
      })
    }
  }

  const handleDiscountChange = (newDiscount: number) => {
    const normalizedDiscount = Math.min(100, Math.max(0, Number.isFinite(newDiscount) ? newDiscount : 0))
    const wasWithinLimit = (activeBillingInstance?.discount ?? 0) <= 10

    if (normalizedDiscount > 10 && wasWithinLimit) {
      toast({
        title: "Approval Required",
        description: "Discounts above 10% require approval before saving.",
        variant: "default",
      })
    }

    updateBillingInstance(activeTab, {
      discount: normalizedDiscount,
      isEditingTotal: false,
      discountRequestId: null,
      discountApprovalStatus: normalizedDiscount > 10 ? "pending" : "not_required",
    })
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

  const requestDiscountApproval = async (discountPercentage: number, discountAmount: number) => {
    const response = await apiClient("/api/discounts/request", {
      method: "POST",
      body: JSON.stringify({
        discount_percentage: discountPercentage,
        discount_amount: discountAmount,
      }),
    })

    if (!response.ok) {
      let errorMessage = "Failed to request discount approval"
      try {
        const errorData = await response.json()
        errorMessage = errorData.message || errorData.error || errorMessage
      } catch {
        // ignore parse errors
      }
      throw new Error(errorMessage)
    }

    return response.json()
  }

  const handlePreview = async () => {
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

    const tax = calculateTotalTax()

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
      userId: currentUser?.id || "",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subtotal: calculateSubtotal(),
      taxPercentage: 0,  // Not used - we have CGST/SGST
      taxAmount: tax.total,
      cgst: tax.cgst,
      sgst: tax.sgst,
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
      billedBy: currentUser?.name || "",  // ✅ ADDED: User name who created the bill
      items: activeBillingInstance.cartItems,
    };
    if (invoice.discountPercentage > 10) {
      try {
        if (!activeBillingInstance.discountRequestId) {
          const discountResponse = await requestDiscountApproval(
            invoice.discountPercentage,
            invoice.discountAmount
          )
          invoice.discountRequestId = discountResponse.discount_id
          invoice.discountApprovalStatus = discountResponse.status || "pending"
          updateBillingInstance(activeTab, {
            discountRequestId: invoice.discountRequestId || null,
            discountApprovalStatus: invoice.discountApprovalStatus || "pending",
          })
          toast({
            title: "Approval Requested",
            description: "Discount request sent for approval. Please wait.",
            variant: "default",
          })
        } else {
          invoice.discountRequestId = activeBillingInstance.discountRequestId || undefined
          invoice.discountApprovalStatus = activeBillingInstance.discountApprovalStatus || "pending"
        }
      } catch (error: any) {
        toast({
          title: "Request Failed",
          description: error?.message || "Failed to request discount approval.",
          variant: "destructive",
        })
        return
      }
    } else {
      invoice.discountApprovalStatus = "not_required"
      invoice.discountRequestId = undefined
    }

    setCurrentInvoice(invoice)
    setShowPreview(true)
  }

  const handleSaveInvoice = async (invoiceToSave: Invoice, isReplay = false) => {
    if (!isOnline) {
      toast({
        title: "Error",
        description: "Cannot save invoice while offline. Please connect to the internet.",
        variant: "destructive",
      });
      return false;
    }

    try {
      if (invoiceToSave.discountPercentage > 10 && invoiceToSave.discountApprovalStatus !== "approved") {
        toast({
          title: "Approval Required",
          description: "Discount above 10% must be approved before saving.",
          variant: "destructive",
        })
        return false
      }

      console.log("💾 Saving invoice:", invoiceToSave);

      const billData = {
        store_id: invoiceToSave.storeId,
        customer_name: invoiceToSave.customerName || 'Walk-in Customer',
        customer_phone: invoiceToSave.customerPhone || '',
        customer_email: invoiceToSave.customerEmail || '',
        customer_address: invoiceToSave.customerAddress || '',
        subtotal: invoiceToSave.subtotal,
        tax_percentage: 0,
        tax_amount: invoiceToSave.taxAmount,
        discount_percentage: invoiceToSave.discountPercentage,
        discount_amount: invoiceToSave.discountAmount,
        discount_request_id: invoiceToSave.discountRequestId || undefined,
        total_amount: invoiceToSave.total,
        payment_method: invoiceToSave.paymentMethod,
        notes: invoiceToSave.notes || '',
        items: invoiceToSave.items.map((item: any) => ({
          product_id: item.productId,
          quantity: item.quantity,
          unit_price: item.price,
          item_total: item.total
        }))
      };

      console.log("📤 Sending bill data to backend:", billData);

      const response = await apiClient("/api/bills", {
        method: "POST",
        body: JSON.stringify(billData),
      });

      console.log("📥 Response status:", response.status);

      if (response.ok) {
        const result = await response.json();
        console.log("✅ Bill saved successfully:", result);

        toast({
          title: "Success",
          description: `Invoice ${isReplay ? "synced" : "saved"} successfully!`,
          variant: "default",
        });

        if (!isReplay) {
          const newId = `bill-${Date.now()}`;
          const newTabs = billingTabs.map((tab) =>
            tab.id === activeTab ? createNewBillingInstance(newId) : tab
          );
          setBillingTabs(newTabs);
          setActiveTab(newId);
        }

        // Refresh products to update stock immediately
        await fetchProducts();

        setShowPreview(false);
        return true;
      } else {
        let errorMessage = "Failed to save invoice";
        let errorDetails = "";

        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorData.error || errorMessage;
          errorDetails = errorData.error || "";
          console.error("❌ Server error response:", errorData);
        } catch (parseError) {
          const textError = await response.text();
          console.error("❌ Non-JSON error response:", textError.substring(0, 200));
          errorMessage = `Server error: ${response.status} ${response.statusText}`;
        }

        toast({
          title: "Error",
          description: errorMessage,
          variant: "destructive",
        });

        if (errorDetails) {
          console.error("❌ Error details:", errorDetails);
        }

        return false;
      }
    } catch (error: any) {
      console.error("❌ Error saving invoice:", error);

      let errorMessage = "An error occurred while saving the invoice.";
      
      if (error.message) {
        errorMessage = error.message;
      }
      
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        errorMessage = "Network error: Cannot connect to server. Check if backend is running.";
      }

      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
      
      return false;
    }
  };

  const handlePrintAndSave = async (invoiceToPrintAndSave: Invoice) => {
    const saved = await handleSaveInvoice(invoiceToPrintAndSave)
    if (saved) {
      // Printing functionality is handled by InvoicePreview component
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
    if (billingTabs.length === 1) return

    const tabIndex = billingTabs.findIndex((tab) => tab.id === tabId)
    const newTabs = billingTabs.filter((tab) => tab.id !== tabId)
    setBillingTabs(newTabs)

    if (activeTab === tabId) {
      const newActiveIndex = Math.max(0, tabIndex - 1)
      setActiveTab(newTabs[newActiveIndex].id)
    }
  }

  if (!activeBillingInstance) {
    return <div>Loading...</div>
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

      const response = await apiClient("/api/products/upload", {
        method: "POST",
        body: JSON.stringify(jsonData),
      });

      if (response.ok) {
        toast({
          title: "Success",
          description: "Products uploaded successfully!",
          variant: "default",
        })
        fetchProducts();
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
      event.target.value = "";
    }
  };

  const tax = calculateTotalTax()

  return (
    <>
      <div className={`grid ${isMobile ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-2"} gap-6`}>
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
            <CardContent className="space-y-3">
              <Input
                ref={barcodeInputRef}
                placeholder="Scan barcode here..."
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                onKeyDown={handleBarcodeKeyPress}
                className="text-lg font-mono"
                autoComplete="off"
                onFocus={(e) => e.target.select()}
              />
              <p className="text-sm text-green-600">
                Scanner ready – scan continuously, press Enter to add
              </p>
              {lastScanned && (
                <div className="text-sm text-gray-700 bg-gray-50 border rounded p-2">
                  Last scanned:{" "}
                  <span className="font-semibold">{lastScanned.name}</span> — ₹
                  {lastScanned.selling_price}
                </div>
              )}
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
                {(searchTerm.trim() ? filteredProducts : products)
                  .filter((product) => product.stock > 0)
                  .map((product) => (
                  <div
                    key={product.id}
                    className="p-3 hover:bg-gray-50 cursor-pointer border-b last:border-b-0 flex justify-between items-center"
                    onClick={() => addToCart(product.id, 1)}
                  >
                    <div>
                      <p className="font-medium">{product.name}</p>
                      <p className="text-sm text-gray-500">
                        Stock: {product.stock}
                        {product.barcodes && ` • ${product.barcodes.split(',')[0]}${product.barcodes.split(',').length > 1 ? '...' : ''}`}
                        {product.tax > 0 && ` • Tax: ${product.tax}%`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">₹{product.selling_price != null ? product.selling_price.toLocaleString() : '0'}</p>
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
              <TabsList className={isMobile ? "w-full grid grid-cols-3" : ""}>
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
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Shopping Cart */}
                <Card>
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
                                <TableHead>Total</TableHead>
                                <TableHead></TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {tab.cartItems.map((item) => (
                                <TableRow key={item.id}>
                                  <TableCell className="font-medium">
                                    {item.name}
                                    {item.taxPercentage > 0 && (
                                      <span className="text-xs text-gray-500 block">
                                        (Tax: {item.taxPercentage}%)
                                      </span>
                                    )}
                                  </TableCell>
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

                        {tab.discount > 10 && (
                          <Alert>
                            <AlertDescription>
                              Discounts above 10% require approval. Click "Generate Invoice" to send a request.
                            </AlertDescription>
                          </Alert>
                        )}
                      </CardContent>
                    </Card>

                    {/* Billing Summary */}
                    <Card className="mt-6 bg-gradient-to-r from-amber-50 to-orange-50">
                      <CardHeader>
                        <CardTitle className="flex items-center">
                          <Receipt className="h-5 w-5 mr-2" />
                          Invoice Summary
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          <div className="flex justify-between text-lg">
                            <span>Subtotal:</span>
                            <span>₹{calculateSubtotal().toLocaleString()}</span>
                          </div>
                          {tab.discount > 0 && (
                            <div className="flex justify-between text-lg">
                              <span>Discount ({tab.discount.toFixed(2)}%):</span>
                              <span className="text-green-600">-₹{calculateDiscountAmount().toLocaleString()}</span>
                            </div>
                          )}
                          <div className="flex justify-between text-sm text-gray-600">
                            <span>Taxable Amount:</span>
                            <span>₹{calculateTaxableAmount().toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between text-lg">
                            <span>CGST:</span>
                            <span className="text-purple-600">+₹{tax.cgst.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between text-lg">
                            <span>SGST:</span>
                            <span className="text-purple-600">+₹{tax.sgst.toLocaleString()}</span>
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

                        <div className="mt-6 space-y-4">
                          <Button
                            onClick={handlePreview}
                            disabled={tab.cartItems.length === 0 || !currentStore}
                            className="w-full"
                            size="lg"
                          >
                            <FileText className="h-4 w-4 mr-2" />
                            Generate Invoice
                          </Button>
                        </div>

                        {tab.discount > 10 && (
                          <Alert>
                            <AlertDescription>
                              Discounts above 10% require approval. Click "Generate Invoice" to send a request.
                            </AlertDescription>
                          </Alert>
                        )}
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
          onSave={handleSaveInvoice ? (updatedInvoice) => handleSaveInvoice(updatedInvoice) : undefined}
          onPrintAndSave={handlePrintAndSave ? (updatedInvoice) => handlePrintAndSave(updatedInvoice) : undefined}
          initialPaperSize={"Thermal 80mm"}
          initialCustomerName={activeBillingInstance.customerName}
          initialCustomerPhone={activeBillingInstance.customerPhone}
          initialPaymentMethod={activeBillingInstance.paymentMethod}
        />
      )}
    </>
  )
}
