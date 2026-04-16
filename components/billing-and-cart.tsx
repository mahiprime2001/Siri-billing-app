"use client"

import type React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  Loader2,
  AlertCircle,
} from "lucide-react"
import InvoicePreview from "./invoice-preview"
import ReturnsDialog from "./returns-dialog"
import { useRouter } from "next/navigation"
import { useToast } from "@/components/ui/use-toast"
import { useOnlineStatus } from "@/hooks/use-online-status"
import { useIsMobile } from "@/hooks/use-mobile"
import { apiClient } from "@/lib/api-client"
import { authManager } from "@/lib/auth"

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Store {
  id: string;
  name: string;
  address?: string;
  phone?: string;
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
  lineType?: "sale" | "replacement_credit";
  replacementLinkId?: string;
  replacementMeta?: {
    originalEntryId: string;
    originalBillId: string;
    originalProductId: string;
    originalProductName: string;
    originalQuantity: number;
    originalUnitPrice: number;
  } | null;
}

interface ReplacementSessionEntry {
  id: string;
  billId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  reason?: string;
}

interface ReplacementSession {
  sessionId: string;
  createdAt: string;
  originalBillId: string;
  customerName?: string;
  customerPhone?: string;
  entries: ReplacementSessionEntry[];
}

interface InvoiceEditSession {
  billId: string
  editExpiresAt?: string | null
  startedAt?: string
  tabId?: string
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

interface BillingAndCartProps {
  onRequestTransferVerification?: (payload: { orderId: string; barcode: string; productName?: string }) => void
}

type TransferOrderSummary = {
  id: string
  missing_qty_total?: number
}

type TransferOrderDetails = {
  items?: Array<{
    id: string
    assigned_qty?: number
    verified_qty?: number
    products?: {
      name?: string
      barcode?: string
    }
  }>
}

const SUGGESTED_DISCOUNTS = [10]
const MAX_BILL_TABS = 7

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

export default function BillingAndCart({ onRequestTransferVerification }: BillingAndCartProps) {
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
  const [isCloudStockVerified, setIsCloudStockVerified] = useState(false)
  const [productsFirstStableLoad, setProductsFirstStableLoad] = useState(false)
  const [productsLoadError, setProductsLoadError] = useState<string | null>(null)

  const [users, setUsers] = useState<User[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [userStores, setUserStores] = useState<UserStore[]>([])
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [currentStore, setCurrentStore] = useState<Store | null>(null)

  const [billingTabs, setBillingTabs] = useState<BillingInstance[]>([createNewBillingInstance("bill-1")])
  const [activeTab, setActiveTab] = useState<string>("bill-1")

  const [showPreview, setShowPreview] = useState(false)
  const [currentInvoice, setCurrentInvoice] = useState<Invoice | null>(null)
  const [replacementSession, setReplacementSession] = useState<ReplacementSession | null>(null)
  const [replacementTabId, setReplacementTabId] = useState<string | null>(null)
  const [pendingReplacementCloseId, setPendingReplacementCloseId] = useState<string | null>(null)
  const [pendingReplacementAction, setPendingReplacementAction] = useState<{
    type: "clear" | "remove"
    itemId?: string
  } | null>(null)
  const [pendingInvoiceEditCloseId, setPendingInvoiceEditCloseId] = useState<string | null>(null)
  const [isReplacementDialogOpen, setIsReplacementDialogOpen] = useState(false)
  const [invoiceEditSession, setInvoiceEditSession] = useState<InvoiceEditSession | null>(null)
  const [isCancelInvoiceDialogOpen, setIsCancelInvoiceDialogOpen] = useState(false)
  const [cancelInvoiceReason, setCancelInvoiceReason] = useState("")
  const [pendingVerificationPrompt, setPendingVerificationPrompt] = useState<{
    orderId: string
    barcode: string
    productName?: string
  } | null>(null)
  const [missingBarcodeAlert, setMissingBarcodeAlert] = useState<{
    barcode: string
    message: string
  } | null>(null)

  const barcodeInputRef = useRef<HTMLInputElement>(null)
  const saveInFlightRef = useRef(false)
  const fetchProductsReqIdRef = useRef(0)
  const fallbackRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const IDLE_FOCUS_DELAY_MS = 5000
  const billingTabsRef = useRef<BillingInstance[]>([])
  const activeTabRef = useRef<string>("")
  const replacementTabIdRef = useRef<string | null>(null)
  const lastReplacementSessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    billingTabsRef.current = billingTabs
  }, [billingTabs])

  useEffect(() => {
    return () => {
      if (fallbackRetryTimerRef.current) {
        clearTimeout(fallbackRetryTimerRef.current)
        fallbackRetryTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])

  useEffect(() => {
    replacementTabIdRef.current = replacementTabId
  }, [replacementTabId])

  const generateCartItemId = useCallback(() => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, [])

  const focusBarcodeInput = useCallback(() => {
    const input = barcodeInputRef.current
    if (!input) return

    const activeElement = document.activeElement as HTMLElement | null
    const isEditableFieldFocused =
      !!activeElement &&
      (activeElement.tagName === "INPUT" ||
        activeElement.tagName === "TEXTAREA" ||
        activeElement.tagName === "SELECT" ||
        activeElement.isContentEditable)

    // Don't steal focus while user is in another form field.
    if (isEditableFieldFocused && activeElement !== input) return

    if (document.activeElement !== input) {
      input.focus()
    }
  }, [])

  useEffect(() => {
    focusBarcodeInput()
  }, [focusBarcodeInput])

  const resetIdleFocusTimer = useCallback(() => {
    if (idleFocusTimerRef.current) {
      clearTimeout(idleFocusTimerRef.current)
    }

    idleFocusTimerRef.current = setTimeout(() => {
      focusBarcodeInput()
    }, IDLE_FOCUS_DELAY_MS)
  }, [focusBarcodeInput, IDLE_FOCUS_DELAY_MS])

  useEffect(() => {
    const events = ["keydown", "mousedown", "touchstart", "click", "focusin"]
    events.forEach((eventName) => window.addEventListener(eventName, resetIdleFocusTimer))
    resetIdleFocusTimer()

    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, resetIdleFocusTimer))
      if (idleFocusTimerRef.current) {
        clearTimeout(idleFocusTimerRef.current)
      }
    }
  }, [resetIdleFocusTimer])

  const activeBillingInstance = billingTabs.find((tab) => tab.id === activeTab)
  const isInvoiceEditMode = !!invoiceEditSession && invoiceEditSession.tabId === activeTab
  const isReplacementActive = !!replacementSession && replacementTabId === activeTab
  const getProductById = useCallback((productId: string) => products.find((p) => p.id === productId), [products])
  const getAvailableStock = useCallback((productId: string) => getProductById(productId)?.stock ?? null, [getProductById])
  const isCreditLine = useCallback((item: CartItem) => item.lineType === "replacement_credit", [])
  const isSaleLine = useCallback((item: CartItem) => item.lineType !== "replacement_credit", [])

  const getMappedQuantityForItem = useCallback((item: CartItem) => {
    if (!item.replacementMeta || isCreditLine(item)) return 0
    return Math.max(0, Math.min(item.quantity, item.replacementMeta.originalQuantity))
  }, [isCreditLine])

  const getMappedAmountForItem = useCallback((item: CartItem) => {
    if (!item.replacementMeta || isCreditLine(item)) return 0
    const mappedQty = getMappedQuantityForItem(item)
    return Math.round((mappedQty * item.price) * 100) / 100
  }, [getMappedQuantityForItem, isCreditLine])

  const getUsageByReplacementEntry = useCallback((items: CartItem[]) => {
    const usage = new Map<string, string>()
    items.forEach((cartItem) => {
      if (!cartItem.replacementMeta || isCreditLine(cartItem)) return
      usage.set(cartItem.replacementMeta.originalEntryId, cartItem.id)
    })
    return usage
  }, [isCreditLine])

  const applyReplacementSessionToTab = useCallback((session: ReplacementSession, targetTabId: string) => {
    if (!session.entries || session.entries.length === 0) return

    setBillingTabs((prevTabs) =>
      (prevTabs.some((tab) => tab.id === targetTabId) ? prevTabs : [...prevTabs, createNewBillingInstance(targetTabId)]).map((tab) => {
        if (tab.id !== targetTabId) return tab

        const currentCart = tab.cartItems
        const existingCredits = new Set(
          currentCart
            .filter((item) => isCreditLine(item) && item.replacementLinkId)
            .map((item) => item.replacementLinkId as string),
        )

        const newCreditLines: CartItem[] = session.entries
          .filter((entry) => entry.quantity > 0 && !existingCredits.has(entry.id))
          .map((entry) => ({
            id: generateCartItemId(),
            productId: entry.productId,
            name: `${entry.productName} (Replacement Credit)`,
            quantity: entry.quantity,
            price: -Math.abs(entry.unitPrice || 0),
            sellingPrice: -Math.abs(entry.unitPrice || 0),
            total: -Math.abs((entry.unitPrice || 0) * entry.quantity),
            barcodes: "",
            taxPercentage: 0,
            hsnCode: "",
            hsn_code_id: undefined,
            lineType: "replacement_credit",
            replacementLinkId: entry.id,
            replacementMeta: {
              originalEntryId: entry.id,
              originalBillId: entry.billId,
              originalProductId: entry.productId,
              originalProductName: entry.productName,
              originalQuantity: entry.quantity,
              originalUnitPrice: entry.unitPrice,
            },
          }))

        const nextCartItems = [...currentCart, ...newCreditLines]

        return {
          ...tab,
          cartItems: nextCartItems,
          customerName: session.customerName || tab.customerName,
          customerPhone: session.customerPhone || tab.customerPhone,
        }
      }),
    )
  }, [generateCartItemId, isCreditLine])

  const hydrateReplacementSession = useCallback(() => {
    if (typeof window === "undefined") return
    const raw = window.sessionStorage.getItem("replacement-session")
    if (!raw) return

    try {
      const parsed: ReplacementSession = JSON.parse(raw)
      if (!parsed?.entries?.length) return

      if (parsed.sessionId && lastReplacementSessionIdRef.current === parsed.sessionId) {
        return
      }

      setReplacementSession(parsed)

      let targetTabId = replacementTabIdRef.current
      const currentTabs = billingTabsRef.current
      const hasReplacementTab = targetTabId && currentTabs.some((tab) => tab.id === targetTabId)
      if (!hasReplacementTab) {
        const emptyTab = currentTabs.find((tab) => tab.cartItems.length === 0)
        if (emptyTab) {
          targetTabId = emptyTab.id
        } else if (currentTabs.length < MAX_BILL_TABS) {
          targetTabId = `repl-${Date.now()}`
        } else {
          targetTabId = activeTabRef.current
        }
      }
      if (!targetTabId) return

      if (replacementTabIdRef.current !== targetTabId) {
        setReplacementTabId(targetTabId)
      }
      if (activeTabRef.current !== targetTabId) {
        setActiveTab(targetTabId)
      }

      applyReplacementSessionToTab(parsed, targetTabId)
      lastReplacementSessionIdRef.current = parsed.sessionId
    } catch (error) {
      console.error("Failed to parse replacement session:", error)
    }
  }, [applyReplacementSessionToTab])

  useEffect(() => {
    hydrateReplacementSession()
    window.addEventListener("start-replacement-session", hydrateReplacementSession as EventListener)
    return () => {
      window.removeEventListener("start-replacement-session", hydrateReplacementSession as EventListener)
    }
  }, [hydrateReplacementSession])

  const hydrateInvoiceEditSession = useCallback(async () => {
    if (typeof window === "undefined") return
    const raw = window.sessionStorage.getItem("invoice-edit-session")
    if (!raw) return

    // Clear immediately to prevent duplicate hydration from event + mount
    window.sessionStorage.removeItem("invoice-edit-session")

    let parsed: InvoiceEditSession | null = null
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      console.error("Failed to parse invoice edit session:", error)
      return
    }

    if (!parsed?.billId) return

    try {
      const response = await apiClient(`/api/bills/${parsed.billId}/edit-payload`, { method: "GET" })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        toast({
          title: "Edit unavailable",
          description: payload?.message || "Invoice edit is not available.",
          variant: "destructive",
        })
        return
      }

      const bill = payload?.bill || {}
      const items = Array.isArray(payload?.items) ? payload.items : []
      const editTabId = `edit-${parsed.billId}-${Date.now()}`
      const targetTabId = editTabId

      // Check tab limit before creating a new edit tab
      if (billingTabsRef.current.length >= MAX_BILL_TABS) {
        toast({
          title: "Tab Limit Reached",
          description: `Close a tab before editing. Maximum ${MAX_BILL_TABS} tabs allowed.`,
          variant: "destructive",
        })
        return
      }

      const mappedItems: CartItem[] = items.map((item: any) => {
        const taxPercentage = Number(item.taxPercentage || 0)
        const basePrice = Number(item.price || 0)
        const quantity = Number(item.quantity || 0)
        const sellingPrice = Math.round((basePrice * (1 + taxPercentage / 100)) * 100) / 100
        return {
          id: generateCartItemId(),
          productId: item.productId || "",
          name: item.name || "Unknown Item",
          quantity,
          price: basePrice,
          sellingPrice,
          total: Math.round(basePrice * quantity * 100) / 100,
          barcodes: item.barcodes || "",
          taxPercentage,
          hsnCode: item.hsnCode || "",
          hsn_code_id: undefined,
          lineType: "sale",
          replacementLinkId: undefined,
          replacementMeta: null,
        }
      })

      setBillingTabs((prevTabs) => {
        const tabs = prevTabs.some((tab) => tab.id === targetTabId)
          ? prevTabs
          : [...prevTabs, createNewBillingInstance(targetTabId)]

        return tabs.map((tab) => {
          if (tab.id !== targetTabId) return tab
          return {
            ...tab,
            cartItems: mappedItems,
            customerName: bill?.customers?.name || bill?.customerName || tab.customerName || "Walk-in Customer",
            customerPhone: bill?.customers?.phone || bill?.customerPhone || "",
            discount: Number(bill?.discount_percentage || bill?.discountPercentage || 0),
            paymentMethod: bill?.paymentmethod || bill?.paymentMethod || tab.paymentMethod || "Cash",
            discountRequestId: null,
            discountApprovalStatus: "not_required",
            editableTotal: Number(bill?.total || 0),
            isEditingTotal: false,
          }
        })
      })

      if (activeTabRef.current !== targetTabId) {
        setActiveTab(targetTabId)
      }
      setInvoiceEditSession({
        billId: parsed.billId,
        editExpiresAt: parsed.editExpiresAt || null,
        startedAt: parsed.startedAt,
        tabId: targetTabId,
      })

      toast({
        title: "Invoice loaded",
        description: `Invoice ${parsed.billId} is loaded in Billing Cart for editing.`,
      })
    } catch (error: any) {
      console.error("Failed to hydrate invoice edit session:", error)
      toast({
        title: "Edit load failed",
        description: error?.message || "Could not load invoice edit data.",
        variant: "destructive",
      })
    }
  }, [generateCartItemId, toast])

  useEffect(() => {
    void hydrateInvoiceEditSession()
    const listener = () => {
      void hydrateInvoiceEditSession()
    }
    window.addEventListener("start-invoice-edit-session", listener)
    return () => {
      window.removeEventListener("start-invoice-edit-session", listener)
    }
  }, [hydrateInvoiceEditSession])

  useEffect(() => {
    if (!isInvoiceEditMode) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = "Closing this tab will discard invoice update progress."
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [isInvoiceEditMode])

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

    // Tax is computed on the post-discount taxable base (GST applies after discount).
    const subtotal = activeBillingInstance.cartItems.reduce((sum, item) => sum + item.total, 0)
    const discountFactor = subtotal > 0 ? (1 - activeBillingInstance.discount / 100) : 1
    let totalTaxAmount = 0

    activeBillingInstance.cartItems.forEach(item => {
      const itemTaxableBase = item.total * discountFactor
      const itemTaxAmount = (itemTaxableBase * item.taxPercentage) / 100
      totalTaxAmount += itemTaxAmount
    })

    const cgst = totalTaxAmount / 2
    const sgst = totalTaxAmount / 2

    return {
      cgst: Math.round(cgst * 100) / 100,
      sgst: Math.round(sgst * 100) / 100,
      total: Math.round(totalTaxAmount * 100) / 100
    }
  }, [activeBillingInstance])

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

  const handleLogout = () => {
    authManager.clearAuth();
    toast({
      title: "Logout Successful",
      description: "You have been successfully logged out.",
      variant: "default",
    });
    router.replace("/login");

    // Best-effort server logout; do not block UX.
    void (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);
      try {
        await apiClient("/api/auth/logout", { method: "POST", signal: controller.signal });
      } catch (error) {
        console.warn("Background logout request failed:", error);
      } finally {
        clearTimeout(timeoutId);
      }
    })();
  };

  const clearReplacementSession = () => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem("replacement-session")
    }
    setReplacementSession(null)
    setReplacementTabId(null)
    lastReplacementSessionIdRef.current = null
  }

  const clearInvoiceEditSession = () => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem("invoice-edit-session")
    }
    setInvoiceEditSession(null)
    setIsCancelInvoiceDialogOpen(false)
  }

  const sortProductsByName = useCallback((items: Product[]) => {
    return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  }, [])

  useEffect(() => {
    if (searchTerm.trim() === "") {
      setFilteredProducts(showAllProducts ? products : [])
    } else {
      const normalizedSearch = searchTerm.trim().replace(/^0+/, "")
      const filtered = sortProductsByName(products.filter(
        (product) =>
          product.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (product.barcodes &&
            product.barcodes
              .split(",")
              .map((b: string) => b.trim().replace(/^0+/, ""))
              .some((b: string) => b.includes(normalizedSearch) || normalizedSearch.includes(b))),
      ))
      setFilteredProducts(filtered)
    }
  }, [searchTerm, products, showAllProducts, sortProductsByName])

  const updateBillingInstance = (tabId: string, updates: Partial<BillingInstance>) => {
    setBillingTabs((prevTabs) =>
      prevTabs.map((tab) => (tab.id === tabId ? { ...tab, ...updates } : tab)),
    )
  }

  const fetchProducts = async () => {
    const reqId = ++fetchProductsReqIdRef.current;
    try {
      setIsLoadingProducts(true);
      const response = await apiClient("/api/products");

      if (reqId !== fetchProductsReqIdRef.current) return;

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const fallbackUsed = response.headers.get("X-Fallback-Used") === "1"
      const partial = response.headers.get("X-Partial") === "1"
      const source = response.headers.get("X-Data-Source") || ""
      // Both "cloud" and "cloud_cache" reflect a recent Supabase read; only
      // "local_snapshot" (fallback_used=1) is truly stale disk data.
      // A partial response means some pages failed — don't trust it as "verified".
      setIsCloudStockVerified(!fallbackUsed && !partial)
      if (fallbackUsed) {
        console.warn(`⚠️ Products served from fallback source: ${source || "local_snapshot"}`)
      }
      if (partial) {
        console.warn(`⚠️ Products response was partial — some pages failed; will retry.`)
      }
      console.log("✅ Fetched store inventory products:", data.length, "items");

      if (reqId !== fetchProductsReqIdRef.current) return;

      // Don't let a stale fallback snapshot OR a partial response shrink an already-populated list.
      setProducts((prev) => {
        if ((fallbackUsed || partial) && prev.length > 0 && data.length < prev.length) {
          console.warn("⚠️ Ignoring incomplete response — keeping current product list");
          return prev;
        }
        return sortProductsByName(data);
      });
      setFilteredProducts([]);
      setProductsLoadError(null);
      if (!fallbackUsed && !partial) {
        setProductsFirstStableLoad(true);
      }

      // Schedule a single retry when the backend served fallback or partial data,
      // so the user picks up the real list without manual refresh.
      if (fallbackUsed || partial) {
        if (fallbackRetryTimerRef.current) {
          clearTimeout(fallbackRetryTimerRef.current)
        }
        fallbackRetryTimerRef.current = setTimeout(() => {
          fallbackRetryTimerRef.current = null
          console.log(`🔁 Retrying products fetch after ${partial ? "partial" : "fallback"} response`);
          fetchProducts()
        }, 3000)
      } else if (fallbackRetryTimerRef.current) {
        clearTimeout(fallbackRetryTimerRef.current)
        fallbackRetryTimerRef.current = null
      }
    } catch (error) {
      if (reqId !== fetchProductsReqIdRef.current) return;
      console.error("❌ Error fetching store inventory products:", error);
      setProductsLoadError(error instanceof Error ? error.message : "Failed to fetch products");
      toast({
        title: "Network Error",
        description: "Failed to fetch store products. Check your connection.",
        variant: "destructive",
      });
    } finally {
      if (reqId === fetchProductsReqIdRef.current) {
        setIsLoadingProducts(false);
      }
    }
  };

  useEffect(() => {
    if (!currentStore) return

    fetchProducts()

    const streamUrl = "http://localhost:8080/api/stock/stream"
    const source = new EventSource(streamUrl, { withCredentials: true })

    // Cap delta fetches. Bigger bursts fall back to a full refresh.
    const DELTA_MAX = 10

    const applyDeltaForIds = async (productIds: string[]) => {
      const unique = Array.from(new Set(productIds.filter(Boolean)))
      if (unique.length === 0) return

      if (unique.length > DELTA_MAX) {
        fetchProducts()
        return
      }

      try {
        const results = await Promise.all(
          unique.map(async (id) => {
            try {
              const res = await apiClient(`/api/products/${encodeURIComponent(id)}`)
              if (!res.ok) return { id, product: null as Product | null, missing: res.status === 404 }
              const product = (await res.json()) as Product
              return { id, product, missing: false }
            } catch (err) {
              console.warn(`⚠️ Delta fetch failed for ${id}:`, err)
              return { id, product: null as Product | null, missing: false }
            }
          })
        )

        setProducts((prev) => {
          const byId = new Map(prev.map((p) => [p.id, p]))
          let changed = false
          for (const { id, product, missing } of results) {
            if (missing) {
              if (byId.delete(id)) changed = true
              continue
            }
            if (!product) continue
            const existing = byId.get(id)
            if (!existing || existing.stock !== product.stock || existing.selling_price !== product.selling_price) {
              byId.set(id, { ...existing, ...product })
              changed = true
            }
          }
          if (!changed) return prev
          return sortProductsByName(Array.from(byId.values()))
        })
      } catch (error) {
        console.error("❌ Delta apply failed, falling back to full refresh:", error)
        fetchProducts()
      }
    }

    source.addEventListener("stock", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data || "{}")
        if (data.store_id && data.store_id !== currentStore.id) return

        const ids: string[] = Array.isArray(data.product_ids) ? data.product_ids.map(String) : []
        if (ids.length > 0) {
          applyDeltaForIds(ids)
        } else {
          fetchProducts()
        }
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
      if (isCreditLine(item)) {
        acc.push(item)
        return acc
      }

      const stock = getAvailableStock(item.productId)

      if (stock === null) {
        acc.push(item)
        return acc
      }

      // Do not auto-remove items when live stock briefly reports 0.
      // This can happen during refresh/fallback races and causes cart flicker.
      // Keep the line in cart; final stock enforcement happens on bill submit.
      if (stock <= 0) {
        acc.push(item)
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
  }, [activeBillingInstance?.cartItems, activeTab, getAvailableStock, isCreditLine])

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

  const addToCart = (productId: string, qty = 1, productOverride?: Product): boolean => {
    if (!activeBillingInstance) {
      toast({
        title: "Billing Unavailable",
        description: "No active billing tab found. Open a bill and try again.",
        variant: "destructive",
      })
      return false
    }
    const product = productOverride || products.find((p) => p.id === productId)
    if (!product) {
      toast({
        title: "Product Unavailable",
        description: "This product is not available for this store.",
        variant: "destructive",
      })
      return false
    }
    if (product.stock <= 0) {
      toast({
        title: "Out of Stock",
        description: `${product.name} is out of stock.`,
        variant: "destructive",
      })
      return false
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

    const existingItem = activeBillingInstance.cartItems.find(
      (item) => item.productId === product.id && item.lineType !== "replacement_credit",
    )
    const currentQty = existingItem?.quantity ?? 0
    const maxAddable = product.stock - currentQty

    if (maxAddable <= 0) {
      toast({
        title: "Stock Limit Reached",
        description: `No more stock available for ${product.name}.`,
        variant: "destructive",
      })
      return false
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
        lineType: "sale",
        replacementLinkId: undefined,
        replacementMeta: null,
      }
      updatedCartItems = [...activeBillingInstance.cartItems, newItem]
    }

    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
    
    const adjustedMsg = finalQty < qty ? ` (added ${finalQty} due to stock)` : ""
    toast({
      title: "Added to Cart",
      description: `${product.name} x${finalQty}${adjustedMsg}`,
    })
    return true
  }

  const normalizeBarcode = (code: string) => {
    return code.trim().replace(/^0+/, "")
  }

  const lookupProductByBarcode = async (rawBarcode: string) => {
    try {
      const response = await apiClient(
        `/api/products?search=${encodeURIComponent(rawBarcode)}&limit=50`,
        { method: "GET" },
      )
      if (!response.ok) return null
      const matches = (await response.json()) as Product[]
      const normalized = normalizeBarcode(rawBarcode)
      return (matches || []).find((candidate) => {
        const barcodes = String(candidate.barcodes || "")
          .split(",")
          .map((b) => normalizeBarcode(b))
          .filter(Boolean)
        return barcodes.includes(normalized)
      }) || null
    } catch (error) {
      console.warn("Barcode server lookup failed:", error)
      return null
    }
  }

  const findPendingTransferForBarcode = async (barcode: string) => {
    try {
      const normalizedBarcode = normalizeBarcode(barcode)
      const ordersRes = await apiClient("/api/stores/current/transfer-orders")
      if (!ordersRes.ok) return null

      const orders = (await ordersRes.json()) as TransferOrderSummary[]
      const candidateOrders = (orders || []).filter((order) => (order.missing_qty_total ?? 0) > 0)

      for (const order of candidateOrders) {
        const detailsRes = await apiClient(`/api/transfer-orders/${order.id}`)
        if (!detailsRes.ok) continue
        const details = (await detailsRes.json()) as TransferOrderDetails
        const items = details.items || []

        for (const item of items) {
          const barcodes = (item.products?.barcode || "")
            .split(",")
            .map((entry) => normalizeBarcode(entry))
            .filter(Boolean)
          if (!barcodes.includes(normalizedBarcode)) continue

          const assigned = Number(item.assigned_qty || 0)
          const verified = Number(item.verified_qty || 0)
          if (verified < assigned) {
            return {
              orderId: order.id,
              productName: item.products?.name || "This product",
            }
          }
        }
      }
    } catch (error) {
      console.error("Error checking pending transfer verification:", error)
    }

    return null
  }

  const handleBarcodeSearch = async () => {
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
      const added = addToCart(product.id, 1)
      if (added) {
        setLastScanned(product)
        setBarcodeInput("")
      }

      setTimeout(() => {
        barcodeInputRef.current?.focus()
      }, 0)
    } else {
      const serverMatchedProduct = await lookupProductByBarcode(rawInput)
      if (serverMatchedProduct) {
        setProducts((prev) => {
          const next = [...prev]
          const existingIndex = next.findIndex((item) => item.id === serverMatchedProduct.id)
          if (existingIndex >= 0) {
            next[existingIndex] = serverMatchedProduct
          } else {
            next.push(serverMatchedProduct)
          }
          return sortProductsByName(next)
        })

        const added = addToCart(serverMatchedProduct.id, 1, serverMatchedProduct)
        if (added) {
          setLastScanned(serverMatchedProduct)
        }
        setBarcodeInput("")
        setTimeout(() => {
          barcodeInputRef.current?.focus()
        }, 0)
        return
      }

      const pendingTransferMatch = await findPendingTransferForBarcode(input)
      setBarcodeInput("")
      if (pendingTransferMatch) {
        setPendingVerificationPrompt({
          orderId: pendingTransferMatch.orderId,
          barcode: rawInput,
          productName: pendingTransferMatch.productName,
        })
      } else {
        setMissingBarcodeAlert({
          barcode: rawInput,
          message: `Product with barcode "${rawInput}" was not found in this store's inventory.`,
        })
      }

      setTimeout(() => {
        barcodeInputRef.current?.focus()
      }, 0)
    }
  }

  const handlePendingVerificationConfirm = () => {
    if (!pendingVerificationPrompt) return
    const payload = pendingVerificationPrompt
    setPendingVerificationPrompt(null)
    onRequestTransferVerification?.({
      orderId: payload.orderId,
      barcode: payload.barcode,
      productName: payload.productName,
    })
  }

  const handleBarcodeKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleBarcodeSearch()
    }
  }

  const cleanReplacementCartItems = useCallback((items: CartItem[]) => {
    return items
      .filter((item) => item.lineType !== "replacement_credit")
      .map((item) => (item.replacementMeta ? { ...item, replacementMeta: null } : item))
  }, [])

  const removeFromCartInternal = (id: string) => {
    if (!activeBillingInstance) return
    const updatedCartItems = activeBillingInstance.cartItems.filter((item) => item.id !== id)
    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
  }

  const removeFromCart = (id: string) => {
    removeFromCartInternal(id)
  }

  const requestRemoveFromCart = (id: string) => {
    if (isReplacementActive) {
      setPendingReplacementAction({ type: "remove", itemId: id })
      return
    }
    removeFromCartInternal(id)
  }

  const toggleReplacementForLine = (itemId: string, enabled: boolean) => {
    if (!activeBillingInstance || !replacementSession || replacementTabId !== activeTab) return

    const targetItem = activeBillingInstance.cartItems.find((item) => item.id === itemId)
    if (!targetItem || isCreditLine(targetItem)) return

    if (!enabled) {
      const updatedCartItems = activeBillingInstance.cartItems.map((item) =>
        item.id === itemId ? { ...item, replacementMeta: null } : item,
      )
      updateBillingInstance(activeTab, { cartItems: updatedCartItems })
      return
    }

    const usage = getUsageByReplacementEntry(
      activeBillingInstance.cartItems.filter((item) => item.id !== itemId),
    )

    const availableEntries = replacementSession.entries
      .filter((entry) => entry.quantity > 0 && !usage.has(entry.id))
      .map((entry) => ({
        entry,
        score: Math.abs((entry.unitPrice || 0) - targetItem.price),
      }))
      .sort((a, b) => a.score - b.score)

    if (availableEntries.length === 0) {
      toast({
        title: "No Replacement Slot",
        description: "All selected return products are already mapped to new lines.",
        variant: "destructive",
      })
      return
    }

    const selectedEntry = availableEntries[0].entry
    const updatedCartItems = activeBillingInstance.cartItems.map((item) =>
      item.id === itemId
        ? {
            ...item,
            replacementMeta: {
              originalEntryId: selectedEntry.id,
              originalBillId: selectedEntry.billId,
              originalProductId: selectedEntry.productId,
              originalProductName: selectedEntry.productName,
              originalQuantity: selectedEntry.quantity,
              originalUnitPrice: selectedEntry.unitPrice,
            },
          }
        : item,
    )

    updateBillingInstance(activeTab, { cartItems: updatedCartItems })
  }

  const updateQuantity = (id: string, newQuantity: number) => {
    if (!activeBillingInstance) return
    const targetItem = activeBillingInstance.cartItems.find((item) => item.id === id)
    if (!targetItem) return
    const product = products.find((p) => p.id === targetItem.productId)

    if (product && product.stock <= 0) {
      removeFromCartInternal(id)
      toast({
        title: "Out of Stock",
        description: `${targetItem.name} is now out of stock and was removed from the cart.`,
        variant: "destructive",
      })
      return
    }

    const cappedQuantity = product ? Math.min(newQuantity, product.stock) : newQuantity

    if (cappedQuantity <= 0) {
      removeFromCartInternal(id)
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
      const integerDiscount = Math.round(newDiscountPercentage)
      updateBillingInstance(activeTab, {
        discount: integerDiscount,
        discountRequestId: null,
        discountApprovalStatus: integerDiscount > 10 ? "pending" : "not_required",
      })
    }
  }

  const handleDiscountChange = (newDiscount: number) => {
    const normalizedDiscount = Math.min(100, Math.max(0, Number.isFinite(newDiscount) ? Math.trunc(newDiscount) : 0))
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

  const clearCartInternal = () => {
    updateBillingInstance(activeTab, {
      cartItems: [],
      discount: 0,
      editableTotal: 0,
      isEditingTotal: false,
    })
  }

  const clearCart = () => {
    if (isReplacementActive) {
      setPendingReplacementAction({ type: "clear" })
      return
    }
    clearCartInternal()
  }

  const generateInvoiceId = () => {
    const now = new Date()
    const dd = String(now.getDate()).padStart(2, "0")
    const mm = String(now.getMonth() + 1).padStart(2, "0")
    const yyyy = String(now.getFullYear())
    // Final bill ID is generated by backend as daily serial; this is preview-only.
    // Use time-based serial so preview does not stay fixed at 0001.
    const secondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
    const previewSerial = String((secondsSinceMidnight % 9999) + 1).padStart(4, "0")
    return `INV-${dd}${mm}${yyyy}${previewSerial}`
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
    const previewInvoiceId =
      isInvoiceEditMode && invoiceEditSession?.billId
        ? invoiceEditSession.billId
        : generateInvoiceId()

    const invoice: Invoice = {
      id: previewInvoiceId,
      storeId: currentStore?.id || "",
      storeName: currentStore?.name || "N/A",
      storeAddress: currentStore?.address || "N/A",
      storePhone: currentStore?.phone || settings?.companyPhone || "",
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
      items: activeBillingInstance.cartItems.map((item) => ({
        ...item,
        replacementTag: item.replacementMeta ? `Replaced Qty: ${getMappedQuantityForItem(item)}` : "",
        replacementMappedQty: item.replacementMeta ? getMappedQuantityForItem(item) : 0,
      })),
    };
    ;(invoice as any).isReplacementBill = !!activeBillingInstance.cartItems.some(
      (item) => item.lineType === "replacement_credit" || !!item.replacementMeta,
    )
    if (invoice.discountPercentage > 10) {
      invoice.discountRequestId = undefined
      invoice.discountApprovalStatus = activeBillingInstance.discountApprovalStatus || "pending"
    } else {
      invoice.discountApprovalStatus = "not_required"
      invoice.discountRequestId = undefined
    }

    setCurrentInvoice(invoice)
    setShowPreview(true)
  }

  const handleSaveInvoice = async (
    invoiceToSave: Invoice,
    isReplay = false,
    options?: { closePreview?: boolean },
  ) => {
    const closePreview = options?.closePreview ?? true
    if (saveInFlightRef.current) {
      console.warn("⚠️ Save request ignored because a save is already in progress.")
      return false
    }
    saveInFlightRef.current = true
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

      const isReplacementInvoice = replacementTabId === activeTab && !!replacementSession
      const isRevisingExistingInvoice = isInvoiceEditMode && !!invoiceEditSession?.billId
      const allItems = (invoiceToSave.items || []) as CartItem[]
      const saleItems = allItems.filter((item) => item.lineType !== "replacement_credit")
      const replacementItemsPayload = isReplacementInvoice
        ? saleItems
            .filter((item) => item.replacementMeta)
            .map((item) => {
              const mappedQty = getMappedQuantityForItem(item)
              if (mappedQty <= 0 || !item.replacementMeta) return null
              const oldUnitPrice = Number(item.replacementMeta.originalUnitPrice || 0)
              const newUnitPrice = Number(item.price || 0)
              const newUnitTax = Number(item.taxPercentage || 0)
              const newUnitPriceWithTax = Math.round(newUnitPrice * (1 + newUnitTax / 100) * 100) / 100
              const finalAmount = Math.round((newUnitPriceWithTax - oldUnitPrice) * mappedQty * 100) / 100
              return {
                original_bill_id: item.replacementMeta.originalBillId,
                replaced_product_id: item.replacementMeta.originalProductId,
                new_product_id: item.productId,
                quantity: mappedQty,
                price: newUnitPriceWithTax,
                final_amount: finalAmount,
              }
            })
            .filter(Boolean)
        : []

      if (saleItems.length === 0) {
        toast({
          title: "No Sale Item",
          description: "Add at least one product in cart to complete billing.",
          variant: "destructive",
        })
        return false
      }

      const existingClientRequestId = (invoiceToSave as unknown as { _clientRequestId?: string })._clientRequestId
      const clientRequestId =
        existingClientRequestId ||
        (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      ;(invoiceToSave as unknown as { _clientRequestId?: string })._clientRequestId = clientRequestId

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
        // Preserve the original billing event time across online/offline flows.
        timestamp: invoiceToSave.timestamp || invoiceToSave.createdAt || new Date().toISOString(),
        created_at: invoiceToSave.createdAt || invoiceToSave.timestamp || new Date().toISOString(),
        original_bill_id: isReplacementInvoice ? replacementSession?.originalBillId || undefined : undefined,
        replacements: replacementItemsPayload,
        _client_request_id: clientRequestId,
        items: saleItems.map((item: any) => ({
          product_id: item.productId,
          quantity: item.quantity,
          unit_price: item.price,
          item_total: item.total,
          tax_percentage: Number(item.taxPercentage || 0),
          hsn_code: item.hsnCode || "",
          name: item.name || "",
          barcode: item.barcodes || "",
        }))
      };

      console.log("📤 Sending bill data to backend:", billData);

      const endpoint = isRevisingExistingInvoice
        ? `/api/bills/${invoiceEditSession?.billId}/revise`
        : "/api/bills"
      const method = isRevisingExistingInvoice ? "PUT" : "POST"

      const response = await apiClient(endpoint, {
        method,
        body: JSON.stringify(billData),
      });

      console.log("📥 Response status:", response.status);

	      if (response.ok) {
	        const result = await response.json();
	        console.log("✅ Bill saved successfully:", result);
	        const wasQueued = response.status === 202 || result?.queued;
	        const persistedBillId = String(
	          result?.bill_id ||
	          result?.bill?.id ||
	          (isRevisingExistingInvoice ? invoiceEditSession?.billId : "") ||
	          invoiceToSave.id ||
	          "",
	        ).trim()
	        if (persistedBillId) {
	          invoiceToSave.id = persistedBillId
	        }
	        const persistedTimestamp =
	          result?.bill?.created_at ||
	          result?.bill?.timestamp ||
	          result?.bill?.createdAt ||
	          invoiceToSave.timestamp
	        if (persistedTimestamp) {
	          invoiceToSave.timestamp = persistedTimestamp
	        }

        toast({
          title: isRevisingExistingInvoice ? "Invoice Updated" : wasQueued ? "Queued" : "Success",
          description: wasQueued
            ? "Internet is offline. Invoice is saved locally and will auto-sync when online."
            : isRevisingExistingInvoice
            ? `Invoice ${invoiceEditSession?.billId} updated successfully!`
            : `Invoice ${isReplay ? "synced" : "saved"} successfully!`,
          variant: "default",
        });

        if (isRevisingExistingInvoice) {
          clearInvoiceEditSession()
          updateBillingInstance(activeTab, {
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
        } else if (!isReplay) {
          const newId = `bill-${Date.now()}`;
          const newTabs = billingTabs.map((tab) =>
            tab.id === activeTab ? createNewBillingInstance(newId) : tab
          );
          setBillingTabs(newTabs);
          setActiveTab(newId);
        }

        // Refresh products when possible; offline queueing should not fail the save flow.
        try {
          await fetchProducts();
        } catch (refreshError) {
          console.warn("Product refresh skipped:", refreshError);
        }

        if (isReplacementInvoice) {
          clearReplacementSession()
        }

	        if (closePreview) {
	          setShowPreview(false)
	        }
	        return invoiceToSave;
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
	    } finally {
	      saveInFlightRef.current = false
	    }
	  };

  const handlePrintAndSave = async (invoiceToPrintAndSave: Invoice) => {
    const saved = await handleSaveInvoice(invoiceToPrintAndSave, false, { closePreview: false })
    if (saved) {
      // Printing functionality is handled by InvoicePreview component
    }
  }

  const handleCancelInvoice = async () => {
    if (!isInvoiceEditMode || !invoiceEditSession?.billId) return
    try {
      const response = await apiClient(`/api/bills/${invoiceEditSession.billId}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          cancel_reason: cancelInvoiceReason.trim() || undefined,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.message || "Failed to cancel invoice")
      }

      toast({
        title: "Invoice Cancelled",
        description: `Invoice ${invoiceEditSession.billId} cancelled and stock restored.`,
      })

      clearInvoiceEditSession()
      setCancelInvoiceReason("")
      updateBillingInstance(activeTab, {
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

      await fetchProducts()
    } catch (error: any) {
      toast({
        title: "Cancel Failed",
        description: error?.message || "Could not cancel invoice.",
        variant: "destructive",
      })
    } finally {
      setIsCancelInvoiceDialogOpen(false)
    }
  }

  const handlePreviewInvoiceUpdate = (updatedInvoice: Invoice) => {
    setCurrentInvoice(updatedInvoice)
    if (activeBillingInstance) {
      updateBillingInstance(activeTab, {
        discountApprovalStatus: updatedInvoice.discountApprovalStatus || activeBillingInstance.discountApprovalStatus,
        discountRequestId: updatedInvoice.discountRequestId || activeBillingInstance.discountRequestId,
      })
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
    if (billingTabs.length >= MAX_BILL_TABS) {
      toast({
        title: "Tab Limit Reached",
        description: `You can open up to ${MAX_BILL_TABS} bill tabs.`,
        variant: "default",
      })
      return
    }
    const newTabId = `bill-${Date.now()}`
    setBillingTabs([...billingTabs, createNewBillingInstance(newTabId)])
    setActiveTab(newTabId)
  }

  const closeTab = (tabId: string) => {
    if (billingTabs.length === 1) return
    if (tabId === replacementTabId) {
      setPendingReplacementCloseId(tabId)
      return
    }
    if (tabId === invoiceEditSession?.tabId) {
      setPendingInvoiceEditCloseId(tabId)
      return
    }

    const tabIndex = billingTabs.findIndex((tab) => tab.id === tabId)
    const newTabs = billingTabs.filter((tab) => tab.id !== tabId)
    setBillingTabs(newTabs)

    if (activeTab === tabId) {
      const newActiveIndex = Math.max(0, tabIndex - 1)
      setActiveTab(newTabs[newActiveIndex].id)
    }
  }

  const confirmCloseReplacementTab = () => {
    if (!pendingReplacementCloseId) return
    const tabId = pendingReplacementCloseId
    setPendingReplacementCloseId(null)

    setBillingTabs((prevTabs) => {
      if (prevTabs.length === 1) return prevTabs
      const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId)
      const newTabs = prevTabs.filter((tab) => tab.id !== tabId)
      if (activeTab === tabId && newTabs.length > 0) {
        const newActiveIndex = Math.max(0, tabIndex - 1)
        setActiveTab(newTabs[newActiveIndex].id)
      }
      return newTabs
    })

    clearReplacementSession()
  }

  const confirmCloseInvoiceEditTab = () => {
    if (!pendingInvoiceEditCloseId) return
    const tabId = pendingInvoiceEditCloseId
    setPendingInvoiceEditCloseId(null)

    setBillingTabs((prevTabs) => {
      if (prevTabs.length === 1) return prevTabs
      const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId)
      const newTabs = prevTabs.filter((tab) => tab.id !== tabId)
      if (activeTab === tabId && newTabs.length > 0) {
        const newActiveIndex = Math.max(0, tabIndex - 1)
        setActiveTab(newTabs[newActiveIndex].id)
      }
      return newTabs
    })

    clearInvoiceEditSession()
  }

  const confirmReplacementAction = () => {
    if (!pendingReplacementAction || !activeBillingInstance) return

    if (pendingReplacementAction.type === "clear") {
      clearCartInternal()
    } else if (pendingReplacementAction.type === "remove" && pendingReplacementAction.itemId) {
      const remaining = activeBillingInstance.cartItems.filter((item) => item.id !== pendingReplacementAction.itemId)
      updateBillingInstance(activeTab, { cartItems: cleanReplacementCartItems(remaining) })
    }

    clearReplacementSession()
    setPendingReplacementAction(null)
  }

  const cancelReplacementAction = () => {
    setPendingReplacementAction(null)
  }

  if (!activeBillingInstance) {
    return <div>Loading...</div>
  }

  const tax = calculateTotalTax()
  const totalVerifiedStoreStock = products.reduce((sum, product) => {
    const stock = Number(product.stock || 0)
    return sum + (Number.isFinite(stock) && stock > 0 ? stock : 0)
  }, 0)

  const blockUI = !productsFirstStableLoad

  return (
    <>
      {blockUI && (
        <div className="fixed inset-0 z-[100] bg-white/80 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 max-w-md text-center px-6 py-8 bg-white border rounded-xl shadow-xl">
            {productsLoadError ? (
              <>
                <AlertCircle className="h-10 w-10 text-red-500" />
                <div>
                  <p className="font-semibold text-gray-900">Couldn't load products</p>
                  <p className="text-sm text-gray-600 mt-1">{productsLoadError}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setProductsLoadError(null)
                    fetchProducts()
                  }}
                  className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
                <div>
                  <p className="font-semibold text-gray-900">Loading store products...</p>
                  <p className="text-sm text-gray-600 mt-1">
                    {isLoadingProducts
                      ? "Fetching the latest inventory from cloud."
                      : "Waiting for a verified stock snapshot."}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
                placeholder={blockUI ? "Loading products..." : "Scan barcode here..."}
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                onKeyDown={handleBarcodeKeyPress}
                className="text-lg font-mono"
                autoComplete="off"
                onFocus={(e) => e.target.select()}
                disabled={blockUI}
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
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                  <Input
                    placeholder={blockUI ? "Loading products..." : "Search products or click to see all..."}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onFocus={handleSearchFocus}
                    onBlur={handleSearchBlur}
                    className="pl-10"
                    disabled={blockUI}
                  />
                </div>
                <Badge variant="secondary" className="whitespace-nowrap">
                  {isCloudStockVerified ? "Verified Stock" : "Snapshot Stock"}: {totalVerifiedStoreStock.toLocaleString()}
                </Badge>
              </div>

              <div className="max-h-96 overflow-y-auto border rounded-md">
                {(searchTerm.trim() ? filteredProducts : products)
                  .filter((product) => product.stock > 0 || isInvoiceEditMode)
                  .map((product) => (
                  <div
                    key={product.id}
                    className={`p-3 border-b last:border-b-0 flex justify-between items-center ${blockUI ? "opacity-60 cursor-not-allowed" : "hover:bg-gray-50 cursor-pointer"}`}
                    onClick={() => {
                      if (blockUI) return
                      addToCart(product.id, 1)
                    }}
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
            <div className="flex flex-wrap items-center gap-2">
              <TabsList className={isMobile ? "w-full grid grid-cols-3" : "flex flex-wrap gap-2 flex-1 min-w-0"}>
                {billingTabs.map((tab, index) => (
                  <TabsTrigger key={tab.id} value={tab.id} className="relative pr-7">
                    {tab.id === replacementTabId ? "Replacement" : tab.id.startsWith("edit-") ? `Edit ${tab.id.split("-")[1]}` : `Bill ${index + 1}`}
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
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  onClick={addTab}
                  size="sm"
                  variant="outline"
                  disabled={billingTabs.length >= MAX_BILL_TABS}
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  onClick={() => setIsReplacementDialogOpen(true)}
                  size="sm"
                  className="bg-blue-900 text-white hover:bg-blue-800"
                >
                  Replace
                </Button>
              </div>
            </div>
            {billingTabs.map((tab) => {
              const isEditingInvoiceTab = !!invoiceEditSession && invoiceEditSession.tabId === tab.id
              const isReplacementTab = !!replacementSession && replacementTabId === tab.id
              const usageMap = isReplacementTab ? getUsageByReplacementEntry(tab.cartItems) : new Map<string, string>()
              const replacementStatus = isReplacementTab
                ? (replacementSession?.entries.map((entry) => {
                    const mappedItemId = usageMap.get(entry.id)
                    const mappedItem = mappedItemId
                      ? tab.cartItems.find((item) => item.id === mappedItemId)
                      : null
                    const mappedQty = mappedItem ? getMappedQuantityForItem(mappedItem) : 0
                    const pendingQty = Math.max(0, entry.quantity - mappedQty)
                    return {
                      ...entry,
                      mappedItemName: mappedItem?.name || null,
                      mappedQty,
                      pendingQty,
                    }
                  }) || [])
                : []
              const mappedReplacementStatus = replacementStatus.filter((entry) => entry.mappedQty > 0)
              const pendingReplacementStatus = replacementStatus.filter((entry) => entry.pendingQty > 0)

              return (
              <TabsContent key={tab.id} value={tab.id} className="mt-4">
                {isEditingInvoiceTab && (
                  <Alert className="mb-4 border-blue-200 bg-blue-50">
                    <AlertDescription>
                      Editing invoice <span className="font-semibold">{invoiceEditSession?.billId}</span>. You can update or cancel this bill within the 24-hour window.
                    </AlertDescription>
                  </Alert>
                )}
                {isReplacementTab && replacementSession && (
                  <Card className="mb-6 border-orange-300 bg-orange-50/50">
                    <CardHeader>
                      <CardTitle className="text-base">Replacement Mapping</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="text-sm">
                        Original Bill: <span className="font-semibold">{replacementSession.originalBillId}</span>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-green-700 mb-1">Selected & Mapped</p>
                        {mappedReplacementStatus.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No mappings selected yet.</p>
                        ) : (
                          <div className="space-y-1">
                            {mappedReplacementStatus.map((entry) => (
                              <p key={entry.id} className="text-sm">
                                {entry.productName} (Qty {entry.quantity}){" -> "}{entry.mappedItemName} (Replaced Qty {entry.mappedQty})
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-amber-700 mb-1">Not Yet Mapped</p>
                        {pendingReplacementStatus.length === 0 ? (
                          <p className="text-sm text-muted-foreground">All selected return items are mapped.</p>
                        ) : (
                          <div className="space-y-1">
                            {pendingReplacementStatus.map((entry) => (
                              <p key={entry.id} className="text-sm">
                                {entry.productName} pending qty {entry.pendingQty}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
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
                                    {item.lineType === "replacement_credit" && (
                                      <span className="text-xs text-red-600 block">
                                        Replacement credit line
                                      </span>
                                    )}
                                    {item.lineType !== "replacement_credit" && isReplacementActive && (
                                      <div className="mt-2 space-y-1">
                                        <label className="text-xs text-gray-600 flex items-center gap-2">
                                          <input
                                            type="checkbox"
                                            checked={!!item.replacementMeta}
                                            onChange={(e) => toggleReplacementForLine(item.id, e.target.checked)}
                                          />
                                          Replace this product
                                        </label>
                                        {item.replacementMeta && (
                                          <>
                                            <span className="text-xs text-green-700 block">
                                              Linked to: {item.replacementMeta.originalProductName} (max {item.replacementMeta.originalQuantity})
                                            </span>
                                            <span className="text-xs text-gray-600 block">
                                              Replaced qty: {getMappedQuantityForItem(item)} | Normal qty: {Math.max(0, item.quantity - getMappedQuantityForItem(item))}
                                            </span>
                                          </>
                                        )}
                                      </div>
                                    )}
                                  </TableCell>
                                  <TableCell>₹{item.price.toLocaleString()}</TableCell>
                                  <TableCell>
                                    <div className="flex items-center space-x-2">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => updateQuantity(item.id, item.quantity - 1)}
                                        disabled={item.lineType === "replacement_credit"}
                                      >
                                        -
                                      </Button>
                                      <span>{item.quantity}</span>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => updateQuantity(item.id, item.quantity + 1)}
                                        disabled={item.lineType === "replacement_credit"}
                                      >
                                        +
                                      </Button>
                                    </div>
                                  </TableCell>
                                  <TableCell>₹{item.total.toLocaleString()}</TableCell>
                                  <TableCell>
                                    <Button variant="outline" size="sm" onClick={() => requestRemoveFromCart(item.id)}>
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
                        {isEditingInvoiceTab && (
                          <Button
                            onClick={() => setIsCancelInvoiceDialogOpen(true)}
                            variant="destructive"
                            className="mt-4"
                            size="lg"
                          >
                            Cancel Invoice
                          </Button>
                        )}
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
                              step="1"
                              inputMode="numeric"
                              value={isNaN(tab.discount) || tab.discount === 0 ? "" : tab.discount}
                              onChange={(e) => handleDiscountChange(Number.parseInt(e.target.value, 10) || 0)}
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
                              <span>Discount ({Math.round(tab.discount)}%):</span>
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
                            {isEditingInvoiceTab ? "Update Invoice" : "Generate Invoice"}
                          </Button>
                          {isEditingInvoiceTab && (
                            <Button
                              onClick={() => setIsCancelInvoiceDialogOpen(true)}
                              variant="destructive"
                              className="w-full"
                              size="lg"
                            >
                              Cancel Invoice
                            </Button>
                          )}
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
              )
            })}
          </Tabs>
        </div>
      </div>

      <ReturnsDialog
        isOpen={isReplacementDialogOpen}
        onClose={() => setIsReplacementDialogOpen(false)}
        user={currentUser ? { name: currentUser.name } : null}
        onStartReplacement={() => setIsReplacementDialogOpen(false)}
        mode="replacement"
        allowReturns={false}
      />

      <AlertDialog
        open={!!pendingReplacementCloseId}
        onOpenChange={(open) => {
          if (!open) setPendingReplacementCloseId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close replacement tab?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear the replacement session and its cached data for this tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmCloseReplacementTab}>
              Close Replacement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingReplacementAction}
        onOpenChange={(open) => {
          if (!open) setPendingReplacementAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Exit replacement mode?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingReplacementAction?.type === "clear"
                ? "This will clear all items, remove the replacement session, and return this tab to a normal bill."
                : "This will remove the product, clear the replacement session, and return this tab to a normal bill."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelReplacementAction}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReplacementAction}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingInvoiceEditCloseId}
        onOpenChange={(open) => {
          if (!open) setPendingInvoiceEditCloseId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close invoice edit tab?</AlertDialogTitle>
            <AlertDialogDescription>
              This will close the updating invoice tab and discard unsaved invoice changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmCloseInvoiceEditTab}>Close Tab</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isCancelInvoiceDialogOpen} onOpenChange={setIsCancelInvoiceDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the invoice as cancelled and restore all stock quantities back to inventory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancelInvoiceReason">Reason (optional)</Label>
            <Textarea
              id="cancelInvoiceReason"
              value={cancelInvoiceReason}
              onChange={(e) => setCancelInvoiceReason(e.target.value)}
              placeholder="Example: Customer requested cancellation"
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction onClick={handleCancelInvoice}>Yes, Cancel Invoice</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingVerificationPrompt} onOpenChange={(nextOpen) => !nextOpen && setPendingVerificationPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Product Not Verified</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingVerificationPrompt?.productName || "This product"} is still not verified. Verify it first to make a proper bill.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handlePendingVerificationConfirm}>Verify</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!missingBarcodeAlert} onOpenChange={(nextOpen) => !nextOpen && setMissingBarcodeAlert(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Barcode Not Found</AlertDialogTitle>
            <AlertDialogDescription>
              {missingBarcodeAlert?.message} {missingBarcodeAlert?.barcode ? `(${missingBarcodeAlert.barcode})` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setMissingBarcodeAlert(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {showPreview && currentInvoice && (
        <InvoicePreview
          invoice={currentInvoice}
          isOpen={showPreview}
          onClose={() => setShowPreview(false)}
          onSave={handleSaveInvoice ? (updatedInvoice) => handleSaveInvoice(updatedInvoice) : undefined}
          onPrintAndSave={handlePrintAndSave ? (updatedInvoice) => handlePrintAndSave(updatedInvoice) : undefined}
          onUpdateInvoice={handlePreviewInvoiceUpdate}
          initialPaperSize={"Thermal 80mm"}
          initialCustomerName={activeBillingInstance.customerName}
          initialCustomerPhone={activeBillingInstance.customerPhone}
          initialPaymentMethod={activeBillingInstance.paymentMethod}
        />
      )}
    </>
  )
}
