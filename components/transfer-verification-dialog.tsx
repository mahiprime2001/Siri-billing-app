"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { apiClient } from "@/lib/api-client"
import { ChevronDown, ChevronRight, Loader2, MoreVertical, ScanLine } from "lucide-react"

type TransferOrder = {
  id: string
  status: string
  created_at: string
  assigned_qty_total?: number
  verified_qty_total?: number
  damaged_qty_total?: number
  wrong_store_qty_total?: number
  missing_qty_total?: number
}

type TransferItem = {
  id: string
  product_id: string
  assigned_qty: number
  verified_qty: number
  damaged_qty: number
  wrong_store_qty: number
  missing_qty: number
  last_verified_at?: string | null
  products?: {
    name?: string
    barcode?: string
    price?: number | string
    selling_price?: number | string
    sellingPrice?: number | string
    mrp?: number | string
    unit_price?: number | string
  }
}

type TransferOrderDetails = {
  id: string
  status: string
  items: TransferItem[]
}

type ScanRow = {
  id: string
  order_id: string
  transfer_item_id: string
  barcode: string
  product_name: string
  selling_price?: number | string
  quantity: number
  status: "pending" | "verified" | "damaged"
  entry_mode: "scan" | "manual"
}

type ScanLog = {
  order_id: string
  transfer_item_id: string
  product_name: string
  selling_price?: number | string
  barcode: string
  quantity: number
  entry_mode: "scan" | "manual"
  event_type: "verified" | "damaged"
  logged_at: string
}

type ItemEdit = {
  verified_qty: number
  damaged_qty: number
  wrong_store_qty: number
  damage_reason?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onVerificationSaved?: () => void
  initialSelectedOrderId?: string
}

const AUTO_SCOPE = "__all"
const normalizeBarcode = (value: string) => value.trim().replace(/^0+/, "")

export default function TransferVerificationDialog({ open, onOpenChange, onVerificationSaved, initialSelectedOrderId }: Props) {
  const { toast } = useToast()
  const scanInputRef = useRef<HTMLInputElement | null>(null)
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([])
  const inFlightDetailPromises = useRef<Map<string, Promise<TransferOrderDetails | null>>>(new Map())

  const [loadingOrders, setLoadingOrders] = useState(false)
  const [loadingOrderDetails, setLoadingOrderDetails] = useState(false)
  const [orders, setOrders] = useState<TransferOrder[]>([])
  const [sessionScopeOrderIds, setSessionScopeOrderIds] = useState<string[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>("")
  const [orderDetailsById, setOrderDetailsById] = useState<Record<string, TransferOrderDetails>>({})
  const [itemEditsByOrder, setItemEditsByOrder] = useState<Record<string, Record<string, ItemEdit>>>({})
  const [saving, setSaving] = useState(false)
  const [scanInput, setScanInput] = useState("")
  const [scanningBarcode, setScanningBarcode] = useState(false)
  const [scanRows, setScanRows] = useState<ScanRow[]>([])
  const [scanLogs, setScanLogs] = useState<ScanLog[]>([])
  const [activeViewTab, setActiveViewTab] = useState<"scan" | "history">("scan")
  const [touchedOrderIds, setTouchedOrderIds] = useState<string[]>([])
  const [confirmDamagedRowId, setConfirmDamagedRowId] = useState<string | null>(null)
  const [scanErrorDialog, setScanErrorDialog] = useState<{ title: string; description: string } | null>(null)
  const [removingRowIds, setRemovingRowIds] = useState<Set<string>>(new Set())
  const [inventoryFailures, setInventoryFailures] = useState<
    { product_name: string; barcode: string; order_id: string; message: string }[]
  >([])
  const [historyOrders, setHistoryOrders] = useState<
    (TransferOrderDetails & {
      verified_at?: string | null
      assigned_qty_total?: number
      verified_qty_total?: number
      damaged_qty_total?: number
      wrong_store_qty_total?: number
      missing_qty_total?: number
    })[]
  >([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [ordersInitialLoaded, setOrdersInitialLoaded] = useState(false)
  const [historyInitialLoaded, setHistoryInitialLoaded] = useState(false)
  const [guidedScanAll, setGuidedScanAll] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [lastReconcileSummary, setLastReconcileSummary] = useState<{
    at: string
    items_considered: number
    items_applied: number
    items_failed: number
    delta_applied_total: number
    results: {
      transfer_item_id: string | null
      product_id: string | null
      product_name: string
      delta: number
      success: boolean
      message?: string | null
    }[]
  } | null>(null)
  const [expandedHistoryOrderIds, setExpandedHistoryOrderIds] = useState<Record<string, boolean>>({})

  const clearAnimationTimers = () => {
    timerRefs.current.forEach((id) => clearTimeout(id))
    timerRefs.current = []
  }

  const clearSubmissionBuffers = () => {
    setScanRows([])
    setScanLogs([])
    setTouchedOrderIds([])
  }

  const createInitialEdits = (details: TransferOrderDetails): Record<string, ItemEdit> => {
    const initialEdits: Record<string, ItemEdit> = {}
    details.items.forEach((item) => {
      initialEdits[item.id] = {
        verified_qty: Number(item.verified_qty || 0),
        damaged_qty: Number(item.damaged_qty || 0),
        wrong_store_qty: Number(item.wrong_store_qty || 0),
        damage_reason: "",
      }
    })
    return initialEdits
  }

  const loadOrderDetails = async (orderId: string) => {
    const response = await apiClient(`/api/transfer-orders/${orderId}`)
    if (!response.ok) throw new Error(`Failed to fetch order ${orderId}`)
    return (await response.json()) as TransferOrderDetails
  }

  const ensureOrderDetails = async (orderId: string): Promise<TransferOrderDetails | null> => {
    if (!orderId) return null
    const cached = orderDetailsById[orderId]
    if (cached) return cached
    const inflight = inFlightDetailPromises.current.get(orderId)
    if (inflight) return inflight

    const promise = (async () => {
      setLoadingOrderDetails(true)
      try {
        const details = await loadOrderDetails(orderId)
        setOrderDetailsById((prev) => ({ ...prev, [details.id]: details }))
        setItemEditsByOrder((prev) => (prev[details.id] ? prev : { ...prev, [details.id]: createInitialEdits(details) }))
        return details
      } catch (error) {
        console.error("Error loading transfer order details:", orderId, error)
        return null
      } finally {
        setLoadingOrderDetails(false)
        inFlightDetailPromises.current.delete(orderId)
      }
    })()

    inFlightDetailPromises.current.set(orderId, promise)
    return promise
  }

  const loadOrders = async () => {
    setLoadingOrders(true)
    try {
      const response = await apiClient("/api/stores/current/transfer-orders")
      if (!response.ok) throw new Error("Failed to fetch transfer orders")
      const data = (await response.json()) as TransferOrder[]
      setOrders(data)
      setSessionScopeOrderIds(data.map((order) => order.id).filter(Boolean))
    } catch (error) {
      console.error("Error loading transfer orders:", error)
      toast({
        title: "Load Failed",
        description: "Could not fetch transfer orders.",
        variant: "destructive",
      })
    } finally {
      setLoadingOrders(false)
      setOrdersInitialLoaded(true)
    }
  }

  const loadHistoryOrders = async () => {
    setLoadingHistory(true)
    try {
      const response = await apiClient("/api/stores/current/transfer-orders/history")
      if (!response.ok) throw new Error("Failed to fetch transfer history")
      const data = (await response.json()) as TransferOrderDetails[]
      setHistoryOrders(data as any)
    } catch (error) {
      console.error("Error loading transfer history:", error)
      setHistoryOrders([])
    } finally {
      setLoadingHistory(false)
      setHistoryInitialLoaded(true)
    }
  }

  useEffect(() => {
    if (open) {
      setSelectedOrderId(initialSelectedOrderId || "")
      setSessionScopeOrderIds([])
      setOrderDetailsById({})
      setItemEditsByOrder({})
      setScanRows([])
      setScanLogs([])
      setTouchedOrderIds([])
      setScanInput("")
      setActiveViewTab("scan")
      setConfirmDamagedRowId(null)
      setGuidedScanAll(false)
      setRemovingRowIds(new Set())
      setInventoryFailures([])
      setHistoryOrders([])
      setExpandedHistoryOrderIds({})
      setOrdersInitialLoaded(false)
      setHistoryInitialLoaded(false)
      setLastReconcileSummary(null)
      inFlightDetailPromises.current.clear()
      clearAnimationTimers()
      loadOrders()
      loadHistoryOrders()
    }
    return () => {
      clearAnimationTimers()
    }
  }, [open, initialSelectedOrderId])

  useEffect(() => {
    if (!open || !selectedOrderId) return
    ensureOrderDetails(selectedOrderId)
  }, [open, selectedOrderId])

  // "All Orders" mode — preload details for every order once loaded
  useEffect(() => {
    if (!open || selectedOrderId || orders.length === 0) return
    orders.forEach((order) => {
      if (order.id) ensureOrderDetails(order.id)
    })
  }, [open, selectedOrderId, orders])

  useEffect(() => {
    if (!open) return
    const focusTimer = setTimeout(() => {
      scanInputRef.current?.focus()
    }, 120)
    return () => clearTimeout(focusTimer)
  }, [open, loadingOrderDetails])

  const selectedOrderIds = useMemo(() => {
    if (selectedOrderId) return [selectedOrderId]
    return Object.keys(orderDetailsById)
  }, [selectedOrderId, orderDetailsById])

  const findMatchingItem = (
    enteredBarcode: string,
  ): { match: { orderId: string; item: TransferItem } | null; alreadyProcessed: boolean; alreadyOrderId?: string } => {
    const normalized = normalizeBarcode(enteredBarcode)
    const matches: { orderId: string; item: TransferItem }[] = []

    selectedOrderIds.forEach((orderId) => {
      const details = orderDetailsById[orderId]
      if (!details) return

      details.items.forEach((item) => {
        const barcodes = (item.products?.barcode || "")
          .split(",")
          .map((code) => normalizeBarcode(code))
          .filter(Boolean)
        if (barcodes.includes(normalized)) {
          matches.push({ orderId, item })
        }
      })
    })

    const pendingMatches = matches.filter(({ orderId, item }) => {
      const edit = itemEditsByOrder[orderId]?.[item.id]
      const assigned = Number(item.assigned_qty || 0)
      const verified = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
      const damaged = Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
      const wrong = Number(edit?.wrong_store_qty ?? item.wrong_store_qty ?? 0)
      const processed = verified + damaged + wrong
      return processed < assigned
    })

    if (pendingMatches.length === 0) {
      return {
        match: null,
        alreadyProcessed: matches.length > 0,
        alreadyOrderId: matches[0]?.orderId,
      }
    }
    if (pendingMatches.length === 1) return { match: pendingMatches[0], alreadyProcessed: false }

    // If the same barcode exists in multiple orders, auto-pick oldest order first.
    const orderPriority = new Map(
      [...orders]
        .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
        .map((order, idx) => [order.id, idx]),
    )

    const picked = [...pendingMatches].sort((a, b) => {
      const aPriority = orderPriority.get(a.orderId) ?? Number.MAX_SAFE_INTEGER
      const bPriority = orderPriority.get(b.orderId) ?? Number.MAX_SAFE_INTEGER
      return aPriority - bPriority
    })[0]
    return { match: picked, alreadyProcessed: false }
  }

  const findMatchInDetails = (
    enteredBarcode: string,
    details: TransferOrderDetails,
  ): { match: TransferItem | null; alreadyProcessed: boolean; alreadyOrderId?: string } => {
    const normalized = normalizeBarcode(enteredBarcode)
    const matches: TransferItem[] = []
    details.items.forEach((item) => {
      const barcodes = (item.products?.barcode || "")
        .split(",")
        .map((code) => normalizeBarcode(code))
        .filter(Boolean)
      if (barcodes.includes(normalized)) {
        matches.push(item)
      }
    })

    if (matches.length === 0) return { match: null, alreadyProcessed: false }

    const orderId = details.id
    const pending = matches.filter((item) => {
      const edit = itemEditsByOrder[orderId]?.[item.id]
      const assigned = Number(item.assigned_qty || 0)
      const verified = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
      const damaged = Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
      const wrong = Number(edit?.wrong_store_qty ?? item.wrong_store_qty ?? 0)
      return verified + damaged + wrong < assigned
    })

    if (pending.length === 0) return { match: null, alreadyProcessed: true, alreadyOrderId: details.id }
    return { match: pending[0], alreadyProcessed: false }
  }

  const scheduleStatusToVerified = (rowId: string) => {
    const timerId = setTimeout(() => {
      setScanRows((prev) => prev.map((row) => (row.id === rowId && row.status === "pending" ? { ...row, status: "verified" } : row)))
    }, 700)
    timerRefs.current.push(timerId)
  }

  const incrementVerified = (orderId: string, item: TransferItem, barcode: string, entryMode: "scan" | "manual") => {
    const itemBarcodes = (item.products?.barcode || "")
      .split(",")
      .map((code) => normalizeBarcode(code))
      .filter(Boolean)
    if (itemBarcodes.length === 0) {
      setScanErrorDialog({
        title: "Barcode Missing",
        description: "This product has no barcode mapped. Contact admin and map the barcode before scanning.",
      })
      return
    }

    let didUpdate = false
    setItemEditsByOrder((prev) => {
      const orderEdits = prev[orderId] || {}
      const current = orderEdits[item.id] || {
        verified_qty: Number(item.verified_qty || 0),
        damaged_qty: Number(item.damaged_qty || 0),
        wrong_store_qty: Number(item.wrong_store_qty || 0),
        damage_reason: "",
      }
      const assigned = Number(item.assigned_qty || 0)
      const processed = (current.verified_qty || 0) + (current.damaged_qty || 0) + (current.wrong_store_qty || 0)
      if (processed >= assigned) {
        return prev
      }

      didUpdate = true
      return {
        ...prev,
        [orderId]: {
          ...orderEdits,
          [item.id]: {
            ...current,
            verified_qty: current.verified_qty + 1,
          },
        },
      }
    })

    if (!didUpdate) {
      const displayBarcode = (item.products?.barcode || barcode).split(",")[0]?.trim() || barcode
      setScanErrorDialog({
        title: "Already Verified",
        description: `The product with ${displayBarcode} is already verified from the order ${orderId}.`,
      })
      return
    }

    const rowId = `verified-${orderId}-${item.id}`
    setScanRows((prev) => {
      const existingIndex = prev.findIndex((row) => row.id === rowId)
      if (existingIndex >= 0) {
        const next = [...prev]
        next[existingIndex] = {
          ...next[existingIndex],
          quantity: next[existingIndex].quantity + 1,
          selling_price: getItemPrice(item) as number | string | undefined,
          status: "pending",
          entry_mode: entryMode,
          barcode: item.products?.barcode || barcode,
        }
        return next
      }
      return [
        {
          id: rowId,
          order_id: orderId,
          transfer_item_id: item.id,
          barcode: item.products?.barcode || barcode,
          product_name: item.products?.name || item.product_id,
          selling_price: getItemPrice(item) as number | string | undefined,
          quantity: 1,
          status: "pending",
          entry_mode: entryMode,
        },
        ...prev,
      ]
    })

    setScanLogs((prev) => [
      ...prev,
      {
        order_id: orderId,
        transfer_item_id: item.id,
        product_name: item.products?.name || item.product_id,
        selling_price: getItemPrice(item) as number | string | undefined,
        barcode,
        quantity: 1,
        entry_mode: entryMode,
        event_type: "verified",
        logged_at: new Date().toISOString(),
      },
    ])

    setTouchedOrderIds((prev) => (prev.includes(orderId) ? prev : [...prev, orderId]))
    scheduleStatusToVerified(rowId)
  }

  const handleBarcodeForOrder = async (
    entered: string,
    orderId: string,
    entryMode: "scan" | "manual",
  ): Promise<"verified" | "already_verified" | "not_found" | "error"> => {
    try {
      const queryParts = [
        `barcode=${encodeURIComponent(entered)}`,
        `order_id=${encodeURIComponent(orderId)}`,
      ]
      const barcodeResponse = await apiClient(
        `/api/stores/current/transfer-orders/barcode-status?${queryParts.join("&")}`,
      )
      if (!barcodeResponse.ok) return "error"

      const barcodeStatus = await barcodeResponse.json()

      if (barcodeStatus?.already_verified) {
        const verifiedOrderId = String(barcodeStatus?.order_id || orderId)
        const inventoryMissing = !!barcodeStatus?.inventory_missing
        const assignedQty = Number(barcodeStatus?.assigned_qty ?? 0)
        const verifiedQty = Number(barcodeStatus?.verified_qty ?? 0)
        const damagedQty = Number(barcodeStatus?.damaged_qty ?? 0)
        const wrongQty = Number(barcodeStatus?.wrong_store_qty ?? 0)
        setScanInput("")
        setScanErrorDialog({
          title: inventoryMissing ? "Verified But Missing In Inventory" : "Already Verified",
          description: inventoryMissing
            ? `The product with ${entered} is verified in order ${verifiedOrderId}, but missing in store inventory. Click "Reconcile Inventory".`
            : `The product with ${entered} is already verified from the order ${verifiedOrderId} (Assigned ${assignedQty}, Verified ${verifiedQty}, Damaged ${damagedQty}, Wrong ${wrongQty}).`,
        })
        return "already_verified"
      }

      if (!barcodeStatus?.found || !barcodeStatus?.order_id) {
        return "not_found"
      }

      const resolvedOrderId = String(barcodeStatus.order_id)
      const details = await ensureOrderDetails(resolvedOrderId)
      if (!details) {
        setScanInput("")
        setScanErrorDialog({
          title: "Order Load Failed",
          description: `Could not load the transfer order details for order ${resolvedOrderId}.`,
        })
        return "error"
      }

      const backendItemId = String(barcodeStatus?.item_id || "")
      let matchedItem = backendItemId
        ? (details.items || []).find((item) => String(item.id) === backendItemId) || null
        : null

      if (!matchedItem) {
        const resolved = findMatchInDetails(entered, details)
        if (resolved.alreadyProcessed) {
          setScanInput("")
          setScanErrorDialog({
            title: "Already Verified",
            description: `The product with ${entered} is already verified from the order ${resolvedOrderId}.`,
          })
          return "already_verified"
        }
        matchedItem = resolved.match
      }

      if (!matchedItem) {
        return "not_found"
      }

      incrementVerified(resolvedOrderId, matchedItem, entered, entryMode)
      setScanInput("")
      scanInputRef.current?.focus()
      return "verified"
    } catch {
      return "error"
    }
  }

  const handleBarcodeSubmit = async (entryMode: "scan" | "manual") => {
    const entered = scanInput.trim()
    if (!entered) return

    setScanningBarcode(true)
    try {
      // Single order selected — validate against that order only
      if (selectedOrderId) {
        const result = await handleBarcodeForOrder(entered, selectedOrderId, entryMode)
        if (result === "not_found") {
          setScanInput("")
          setScanErrorDialog({
            title: "Wrong Stock",
            description: "This barcode does not belong to the selected transfer order.",
          })
        } else if (result === "error") {
          toast({
            title: "Scan Validation Failed",
            description: "Could not validate this barcode with server. Please try again.",
            variant: "destructive",
          })
        }
        return
      }

      // "All Orders" mode — check all orders in parallel for speed
      const orderIds = sessionScopeOrderIds.length > 0 ? sessionScopeOrderIds : orders.map((o) => o.id).filter(Boolean)
      const results = await Promise.all(
        orderIds.map(async (orderId) => {
          const result = await handleBarcodeForOrder(entered, orderId, entryMode)
          return { orderId, result }
        }),
      )

      // If any resolved as verified or already_verified, handleBarcodeForOrder already handled UI
      if (results.some((r) => r.result === "verified" || r.result === "already_verified")) return

      const hasError = results.some((r) => r.result === "error")
      if (hasError) {
        toast({
          title: "Scan Validation Failed",
          description: "Could not validate this barcode with server. Please try again.",
          variant: "destructive",
        })
      } else {
        setScanInput("")
        setScanErrorDialog({
          title: "Wrong Stock",
          description: "This barcode does not belong to any of your active transfer orders.",
        })
      }
    } finally {
      setScanningBarcode(false)
    }
  }

  const openDamagedConfirm = (rowId: string) => {
    setConfirmDamagedRowId(rowId)
  }

  const confirmDamagedProduct = () => {
    if (!confirmDamagedRowId) return

    const row = scanRows.find((entry) => entry.id === confirmDamagedRowId)
    if (!row || row.quantity <= 0 || row.status === "damaged") {
      setConfirmDamagedRowId(null)
      return
    }

    const details = orderDetailsById[row.order_id]
    const item = details?.items.find((entry) => entry.id === row.transfer_item_id)
    if (!details || !item) {
      setConfirmDamagedRowId(null)
      return
    }

    setItemEditsByOrder((prev) => {
      const orderEdits = prev[row.order_id] || {}
      const current = orderEdits[item.id] || {
        verified_qty: Number(item.verified_qty || 0),
        damaged_qty: Number(item.damaged_qty || 0),
        wrong_store_qty: Number(item.wrong_store_qty || 0),
        damage_reason: "",
      }
      return {
        ...prev,
        [row.order_id]: {
          ...orderEdits,
          [item.id]: {
            ...current,
            verified_qty: Math.max(0, current.verified_qty - 1),
            damaged_qty: current.damaged_qty + 1,
            damage_reason: "Marked damaged during receive scan",
          },
        },
      }
    })

    setScanRows((prev) => {
      const nextRows = prev
        .map((entry) =>
          entry.id === confirmDamagedRowId
            ? { ...entry, quantity: Math.max(0, entry.quantity - 1) }
            : entry,
        )
        .filter((entry) => entry.quantity > 0)

      const damagedRowId = `damaged-${row.order_id}-${row.transfer_item_id}`
      const damagedIndex = nextRows.findIndex((entry) => entry.id === damagedRowId)
      if (damagedIndex >= 0) {
        nextRows[damagedIndex] = {
          ...nextRows[damagedIndex],
          quantity: nextRows[damagedIndex].quantity + 1,
          status: "damaged",
        }
      } else {
        nextRows.unshift({
          id: damagedRowId,
          order_id: row.order_id,
          transfer_item_id: row.transfer_item_id,
          barcode: row.barcode,
          product_name: row.product_name,
          quantity: 1,
          status: "damaged",
          entry_mode: row.entry_mode,
        })
      }
      return nextRows
    })

    setScanLogs((prev) => [
      ...prev,
      {
        order_id: row.order_id,
        transfer_item_id: row.transfer_item_id,
        product_name: row.product_name,
        selling_price: row.selling_price,
        barcode: row.barcode,
        quantity: 1,
        entry_mode: row.entry_mode,
        event_type: "damaged",
        logged_at: new Date().toISOString(),
      },
    ])

    setTouchedOrderIds((prev) => (prev.includes(row.order_id) ? prev : [...prev, row.order_id]))
    setConfirmDamagedRowId(null)
  }

  const getStatusBadge = (status: ScanRow["status"]) => {
    if (status === "pending") {
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Pending...
        </Badge>
      )
    }
    if (status === "damaged") {
      return <Badge variant="destructive">Damaged</Badge>
    }
    return <Badge className="bg-green-600 hover:bg-green-600">Verified</Badge>
  }

  const animateRemoveScanRows = (rowIdsToRemove: string[]) => {
    if (!rowIdsToRemove.length) return
    rowIdsToRemove.forEach((rowId, index) => {
      const fadeDelay = index * 220
      const fadeTimer = setTimeout(() => {
        setRemovingRowIds((prev) => {
          const next = new Set(prev)
          next.add(rowId)
          return next
        })
      }, fadeDelay)
      timerRefs.current.push(fadeTimer)

      const removeTimer = setTimeout(() => {
        setScanRows((prev) => prev.filter((row) => row.id !== rowId))
        setRemovingRowIds((prev) => {
          const next = new Set(prev)
          next.delete(rowId)
          return next
        })
      }, fadeDelay + 360)
      timerRefs.current.push(removeTimer)
    })
  }

  const collectInventoryFailures = (
    batchResult: any,
  ): { product_name: string; barcode: string; order_id: string; message: string }[] => {
    const failures: { product_name: string; barcode: string; order_id: string; message: string }[] = []
    const results = Array.isArray(batchResult?.results) ? batchResult.results : []
    results.forEach((row: any) => {
      const orderId = String(row?.order_id || "")
      const inventoryResults = Array.isArray(row?.inventory_results) ? row.inventory_results : []
      inventoryResults.forEach((entry: any) => {
        if (entry?.success) return
        const transferItemId = entry?.transfer_item_id || entry?.item_id
        const details = orderDetailsById[orderId]
        const item = details?.items.find((it) => it.id === transferItemId)
        const productName = item?.products?.name || entry?.product_name || entry?.product_id || "Unknown product"
        const barcode = (item?.products?.barcode || entry?.barcode || "").split(",")[0]?.trim() || "N/A"
        failures.push({
          product_name: productName,
          barcode,
          order_id: orderId,
          message: entry?.message || "Failed to add to store inventory.",
        })
      })
    })
    return failures
  }

  const resolveProductNameForItem = (transferItemId: string | null, productId: string | null): string => {
    const nameFromItem = (it: TransferItem | undefined): string | undefined => it?.products?.name
    if (transferItemId) {
      for (const details of Object.values(orderDetailsById)) {
        const hit = details?.items?.find((it) => it.id === transferItemId)
        const name = nameFromItem(hit)
        if (name) return name
      }
      for (const order of historyOrders) {
        const hit = order?.items?.find((it) => it.id === transferItemId)
        const name = nameFromItem(hit)
        if (name) return name
      }
    }
    if (productId) {
      for (const details of Object.values(orderDetailsById)) {
        const hit = details?.items?.find((it) => it.product_id === productId)
        const name = nameFromItem(hit)
        if (name) return name
      }
      for (const order of historyOrders) {
        const hit = order?.items?.find((it) => it.product_id === productId)
        const name = nameFromItem(hit)
        if (name) return name
      }
    }
    return productId || "Unknown product"
  }

  const handleReconcileInventory = async () => {
    if (reconciling) return
    setReconciling(true)
    try {
      const response = await apiClient("/api/stores/current/transfer-orders/reconcile-inventory", {
        method: "POST",
        body: JSON.stringify({ repair_missing_inventory_rows: true }),
      })
      if (!response.ok && response.status !== 207) throw new Error("Reconcile request failed")
      const data = await response.json().catch(() => ({} as any))

      const considered = Number(data?.items_considered ?? 0)
      const applied = Number(data?.items_applied ?? 0)
      const failed = Number(data?.items_failed ?? 0)
      const deltaTotal = Number(data?.delta_applied_total ?? 0)
      const rawResults: any[] = Array.isArray(data?.results) ? data.results : []

      const enrichedResults = rawResults.map((r) => ({
        transfer_item_id: r?.transfer_item_id ?? null,
        product_id: r?.product_id ?? null,
        product_name: resolveProductNameForItem(r?.transfer_item_id ?? null, r?.product_id ?? null),
        delta: Number(r?.delta ?? 0),
        success: !!r?.success,
        message: r?.message ?? null,
      }))

      setLastReconcileSummary({
        at: new Date().toISOString(),
        items_considered: considered,
        items_applied: applied,
        items_failed: failed,
        delta_applied_total: deltaTotal,
        results: enrichedResults,
      })

      if (considered === 0) {
        toast({
          title: "Nothing to Reconcile",
          description: "Store inventory is already in sync with verified items.",
        })
      } else if (failed === 0) {
        toast({
          title: "Reconcile Complete",
          description: `Reconciled ${applied} item${applied === 1 ? "" : "s"} • ${deltaTotal} unit${deltaTotal === 1 ? "" : "s"} pushed to inventory.`,
        })
      } else {
        toast({
          title: "Reconcile Completed With Failures",
          description: `${applied} applied • ${failed} failed. See details below.`,
          variant: "destructive",
        })
      }

      const failures = enrichedResults.filter((r) => !r.success)
      if (failures.length > 0) {
        setInventoryFailures(
          failures.map((f) => ({
            product_name: f.product_name,
            barcode: "-",
            order_id: f.transfer_item_id || "-",
            message: f.message || "Inventory write failed",
          })),
        )
      }

      await loadOrders()
      await loadHistoryOrders()
    } catch (error) {
      console.error("Reconcile inventory failed:", error)
      toast({
        title: "Reconcile Failed",
        description: "Could not reconcile store inventory. Please try again.",
        variant: "destructive",
      })
    } finally {
      setReconciling(false)
    }
  }

  const finalizeAfterSave = ({
    closeOnSuccess,
    inventoryFailuresList,
  }: {
    closeOnSuccess: boolean
    inventoryFailuresList: { product_name: string; barcode: string; order_id: string; message: string }[]
  }) => {
    setInventoryFailures(inventoryFailuresList)
    setTouchedOrderIds([])
    setScanLogs([])
    const failedKeys = new Set(
      inventoryFailuresList.map((f) => `${f.order_id}::${f.barcode}`),
    )
    if (closeOnSuccess) {
      setScanRows([])
      onOpenChange(false)
      return
    }
    const rowsToAnimate = scanRows
      .filter((row) => {
        const key = `${row.order_id}::${(row.barcode || "").split(",")[0]?.trim() || row.barcode}`
        return !failedKeys.has(key)
      })
      .map((row) => row.id)
    animateRemoveScanRows(rowsToAnimate)
    loadHistoryOrders()
  }

  const handleSubmit = async ({ closeOnSuccess = true, silentSuccess = false }: { closeOnSuccess?: boolean; silentSuccess?: boolean } = {}) => {
    const orderIdsToSubmit = selectedOrderId
      ? touchedOrderIds.includes(selectedOrderId)
        ? [selectedOrderId]
        : []
      : touchedOrderIds

    if (!orderIdsToSubmit.length) {
      if (!silentSuccess) {
        toast({
          title: "Nothing to Submit",
          description: "Scan at least one product before submitting verification.",
        })
      }
      return
    }

    const verificationSessionId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `ver-${Date.now()}`

    setSaving(true)
    setInventoryFailures([])
    const failures: { orderId: string; message: string }[] = []
    const verifications: {
      order_id: string
      items: {
        transfer_item_id: string
        product_id: string
        verified_qty: number
        damaged_qty: number
        wrong_store_qty: number
        damage_reason?: string
      }[]
      scans: {
        transfer_item_id: string
        barcode: string
        quantity: number
        entry_mode: "scan" | "manual"
        event_type: "verified" | "damaged"
      }[]
    }[] = []

    try {
      for (const orderId of orderIdsToSubmit) {
        const details = orderDetailsById[orderId]
        if (!details) {
          failures.push({ orderId, message: "Order details not loaded" })
          continue
        }

        const orderEdits = itemEditsByOrder[orderId] || {}
        const payloadItems = details.items.map((item) => {
          const edit = orderEdits[item.id] || {
            verified_qty: Number(item.verified_qty || 0),
            damaged_qty: Number(item.damaged_qty || 0),
            wrong_store_qty: Number(item.wrong_store_qty || 0),
            damage_reason: "",
          }
          return {
            transfer_item_id: item.id,
            product_id: item.product_id,
            verified_qty: edit.verified_qty,
            damaged_qty: edit.damaged_qty,
            wrong_store_qty: edit.wrong_store_qty,
            damage_reason: edit.damage_reason,
          }
        })

        const payloadScans = scanLogs
          .filter((scan) => scan.order_id === orderId)
          .map(({ transfer_item_id, barcode, quantity, entry_mode, event_type }) => ({
            transfer_item_id,
            barcode,
            quantity,
            entry_mode,
            event_type,
          }))

        verifications.push({
          order_id: orderId,
          items: payloadItems,
          scans: payloadScans,
        })
      }

      if (!verifications.length) {
        toast({
          title: "Save Failed",
          description: failures[0]?.message || "Could not prepare verification payload.",
          variant: "destructive",
        })
        return
      }

      // Prefer batch endpoint; fallback to legacy per-order endpoint for older backend.
      let usedLegacyFallback = false
      let successCount = 0
      try {
        const batchResponse = await apiClient(`/api/transfer-orders/verify-batch`, {
          method: "POST",
          body: JSON.stringify({
            verification_session_id: verificationSessionId,
            verifications,
          }),
        })

        if (!batchResponse.ok && batchResponse.status !== 404 && batchResponse.status !== 405) {
          const errorPayload = await batchResponse.json().catch(() => ({}))
          throw new Error(errorPayload?.message || "Batch verification failed")
        }

        if (batchResponse.ok) {
          const batchResult = await batchResponse.json().catch(() => null)
          successCount = Number(batchResult?.success_count || 0)
          const failedCount = Number(batchResult?.failed_count || 0)
          const queuedCount = Number(batchResult?.queued_count || 0)

          if ((successCount > 0 || queuedCount > 0) && failedCount === 0) {
            const invFailures = collectInventoryFailures(batchResult)
            if (!silentSuccess) {
              toast({
                title: queuedCount > 0 ? "Verification Queued" : "Verification Saved",
                description:
                  queuedCount > 0
                    ? `Queued ${queuedCount} order${queuedCount > 1 ? "s" : ""}. Sync will continue automatically when online.`
                    : `Updated ${successCount} order${successCount > 1 ? "s" : ""}.${
                        invFailures.length
                          ? ` ${invFailures.length} product(s) failed to add to store inventory.`
                          : ""
                      }`,
                variant: invFailures.length ? "destructive" : "default",
              })
            }
            finalizeAfterSave({ closeOnSuccess, inventoryFailuresList: invFailures })
            onVerificationSaved?.()
            return
          }

          if ((successCount > 0 || queuedCount > 0) && failedCount > 0) {
            toast({
              title: "Partially Saved",
              description: `Saved ${successCount} order(s), queued ${queuedCount} order(s), failed ${failedCount} order(s).`,
              variant: "destructive",
            })
            await loadOrders()
            return
          }

          toast({
            title: "Save Failed",
            description: batchResult?.message || "Could not save verification.",
            variant: "destructive",
          })
          return
        }

        usedLegacyFallback = true
      } catch (error) {
        // If batch endpoint exists but fails, do not silently fallback.
        toast({
          title: "Save Failed",
          description: (error as Error).message || "Could not save verification.",
          variant: "destructive",
        })
        return
      }

      if (usedLegacyFallback) {
        for (const verification of verifications) {
          try {
            const response = await apiClient(`/api/transfer-orders/${verification.order_id}/verify`, {
              method: "POST",
              body: JSON.stringify({
                verification_session_id: `${verificationSessionId}-${verification.order_id}`,
                items: verification.items,
                scans: verification.scans,
              }),
            })
            const result = await response.json()
            if (!response.ok) {
              throw new Error(result?.message || "Failed to submit verification")
            }
            successCount += 1
          } catch (error) {
            failures.push({
              orderId: verification.order_id,
              message: (error as Error).message || "Submission failed",
            })
          }
        }
      }

      if (successCount > 0 && failures.length === 0) {
        if (!silentSuccess) {
          toast({
            title: "Verification Saved",
            description: `Updated ${successCount} order${successCount > 1 ? "s" : ""}.`,
          })
        }
        finalizeAfterSave({ closeOnSuccess, inventoryFailuresList: [] })
        onVerificationSaved?.()
        return
      }

      if (successCount > 0 && failures.length > 0) {
        toast({
          title: "Partially Saved",
          description: `Saved ${successCount} order(s). Failed ${failures.length} order(s).`,
          variant: "destructive",
        })
        await loadOrders()
        return
      }

      toast({
        title: "Save Failed",
        description: failures[0]?.message || "Could not save verification.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  const visibleScanRows = useMemo(
    () => (selectedOrderId ? scanRows.filter((row) => row.order_id === selectedOrderId) : scanRows),
    [scanRows, selectedOrderId],
  )
  const canSave = touchedOrderIds.length > 0

  const getItemPrice = (item: TransferItem): unknown => {
    const rawProduct = item.products as unknown
    const product = (Array.isArray(rawProduct) ? rawProduct[0] : rawProduct) as
      | (TransferItem["products"] & {
          sellingPrice?: number | string
          mrp?: number | string
          unit_price?: number | string
        })
      | undefined

    return (
      product?.selling_price ??
      product?.sellingPrice ??
      (item as unknown as { selling_price?: number | string }).selling_price ??
      (item as unknown as { sellingPrice?: number | string }).sellingPrice
    )
  }

  const formatPrice = (value: unknown) => {
    if (value === null || value === undefined || value === "") return "N/A"
    const numeric =
      typeof value === "string"
        ? Number(value.replace(/[^0-9.-]/g, ""))
        : Number(value)
    if (!Number.isFinite(numeric)) return "N/A"
    return `Rs ${numeric.toFixed(2)}`
  }

  const getOrderMissingQty = (orderId: string) => {
    const details = orderDetailsById[orderId]
    if (!details) {
      const order = orders.find((entry) => entry.id === orderId)
      return Number(order?.missing_qty_total ?? 0)
    }

    return details.items.reduce((missing, item) => {
      const edit = itemEditsByOrder[orderId]?.[item.id]
      const assigned = Number(item.assigned_qty || 0)
      const verified = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
      const damaged = Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
      const wrong = Number(edit?.wrong_store_qty ?? item.wrong_store_qty ?? 0)
      const processed = verified + damaged + wrong
      return missing + Math.max(0, assigned - processed)
    }, 0)
  }

  const getPendingQtyForBarcodeInOrder = (orderId: string, barcodeValue: string) => {
    const details = orderDetailsById[orderId]
    if (!details) return 0

    const normalizedBarcode = normalizeBarcode((barcodeValue || "").split(",")[0] || "")
    if (!normalizedBarcode) return 0

    return details.items.reduce((pending, item) => {
      const itemBarcodes = (item.products?.barcode || "")
        .split(",")
        .map((code) => normalizeBarcode(code))
        .filter(Boolean)
      if (!itemBarcodes.includes(normalizedBarcode)) {
        return pending
      }

      const edit = itemEditsByOrder[orderId]?.[item.id]
      const assigned = Number(item.assigned_qty || 0)
      const verified = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
      const damaged = Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
      const wrong = Number(edit?.wrong_store_qty ?? item.wrong_store_qty ?? 0)
      const processed = verified + damaged + wrong
      return pending + Math.max(0, assigned - processed)
    }, 0)
  }

  const selectableOrders = orders.filter((order) => getOrderMissingQty(order.id) > 0)

  const visibleOrderIds = useMemo(() => {
    if (selectedOrderId) return orderDetailsById[selectedOrderId] ? [selectedOrderId] : []
    return selectableOrders.map((order) => order.id).filter((id) => orderDetailsById[id])
  }, [selectedOrderId, selectableOrders, orderDetailsById])

  const summaryOrderIds = useMemo(() => {
    if (selectedOrderId) return [selectedOrderId]
    return sessionScopeOrderIds
  }, [selectedOrderId, sessionScopeOrderIds])

  const summary = useMemo(() => {
    let assigned = 0
    let verified = 0
    let verifiedTotal = 0
    let damaged = 0
    let wrong = 0

    summaryOrderIds.forEach((orderId) => {
      const details = orderDetailsById[orderId]
      if (details) {
        details.items.forEach((item) => {
          const edit = itemEditsByOrder[orderId]?.[item.id]
          const baseVerified = Number(item.verified_qty || 0)
          const currentVerified = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
          assigned += Number(item.assigned_qty || 0)
          // Session-only verified count: show only what was scanned/changed in this dialog session.
          verified += Math.max(0, currentVerified - baseVerified)
          verifiedTotal += currentVerified
          damaged += Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
          wrong += Number(edit?.wrong_store_qty ?? item.wrong_store_qty ?? 0)
        })
        return
      }
      // Fallback to list-endpoint aggregates when details haven't been lazy-loaded yet.
      const order = orders.find((entry) => entry.id === orderId)
      if (!order) return
      assigned += Number(order.assigned_qty_total || 0)
      verifiedTotal += Number(order.verified_qty_total || 0)
      damaged += Number(order.damaged_qty_total || 0)
      wrong += Number(order.wrong_store_qty_total || 0)
    })

    // Pending/Missing should represent true remaining stock, not just this-session scans.
    const missing = Math.max(0, assigned - verifiedTotal - damaged - wrong)
    return { assigned, verified, damaged, wrong, missing }
  }, [summaryOrderIds, orderDetailsById, itemEditsByOrder, orders])

  const historyOrdersWithVerifiedItems = useMemo(() => {
    return historyOrders
      .map((order) => {
        const verifiedItems = (order.items || [])
          .map((item) => ({ item, verifiedQty: Number(item.verified_qty || 0) }))
          .filter(({ verifiedQty }) => verifiedQty > 0)

        const verifiedTotal = verifiedItems.reduce((sum, row) => sum + row.verifiedQty, 0)
        const assignedTotal = Number(order.assigned_qty_total || 0)
        const damagedTotal = Number(order.damaged_qty_total || 0)
        const wrongStoreTotal = Number(order.wrong_store_qty_total || 0)
        const neededTotal = Math.max(0, assignedTotal - verifiedTotal - damagedTotal - wrongStoreTotal)

        return {
          orderId: order.id,
          verifiedItems,
          verifiedTotal,
          neededTotal,
        }
      })
      .filter((entry) => !!entry.orderId && entry.verifiedItems.length > 0)
  }, [historyOrders])

  const toggleHistoryOrderExpanded = (orderId: string) => {
    setExpandedHistoryOrderIds((prev) => ({ ...prev, [orderId]: !prev[orderId] }))
  }

  const formatHistoryTime = (iso: string) => {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return "N/A"
    return date.toLocaleString()
  }

  const getLastVerifiedTimeForItem = (orderId: string, itemId: string) => {
    const latest = scanLogs
      .filter((log) => log.order_id === orderId && log.transfer_item_id === itemId && log.event_type === "verified")
      .sort((a, b) => new Date(b.logged_at).getTime() - new Date(a.logged_at).getTime())[0]
    return latest?.logged_at || ""
  }

  const markVerifiedUnitDamaged = (orderId: string, item: TransferItem) => {
    const details = orderDetailsById[orderId]
    if (!details) return

    const edit = itemEditsByOrder[orderId]?.[item.id]
    const verifiedQty = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
    if (verifiedQty <= 0) {
      toast({
        title: "No Verified Qty",
        description: "No verified quantity is available to mark as damaged.",
        variant: "destructive",
      })
      return
    }

    setItemEditsByOrder((prev) => {
      const orderEdits = prev[orderId] || {}
      const current = orderEdits[item.id] || {
        verified_qty: Number(item.verified_qty || 0),
        damaged_qty: Number(item.damaged_qty || 0),
        wrong_store_qty: Number(item.wrong_store_qty || 0),
        damage_reason: "",
      }
      return {
        ...prev,
        [orderId]: {
          ...orderEdits,
          [item.id]: {
            ...current,
            verified_qty: Math.max(0, current.verified_qty - 1),
            damaged_qty: current.damaged_qty + 1,
            damage_reason: "Marked damaged from verification history",
          },
        },
      }
    })

    const barcode = (item.products?.barcode || "").split(",")[0]?.trim() || ""
    setScanLogs((prev) => [
      ...prev,
      {
        order_id: orderId,
        transfer_item_id: item.id,
        product_name: item.products?.name || item.product_id,
        selling_price: getItemPrice(item) as number | string | undefined,
        barcode,
        quantity: 1,
        entry_mode: "manual",
        event_type: "damaged",
        logged_at: new Date().toISOString(),
      },
    ])

    setTouchedOrderIds((prev) => (prev.includes(orderId) ? prev : [...prev, orderId]))
  }

  const markVerifiedUnitReturnToAdmin = (orderId: string, item: TransferItem) => {
    const details = orderDetailsById[orderId]
    if (!details) return

    const edit = itemEditsByOrder[orderId]?.[item.id]
    const verifiedQty = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
    if (verifiedQty <= 0) {
      toast({
        title: "No Verified Qty",
        description: "No verified quantity is available to return.",
        variant: "destructive",
      })
      return
    }

    setItemEditsByOrder((prev) => {
      const orderEdits = prev[orderId] || {}
      const current = orderEdits[item.id] || {
        verified_qty: Number(item.verified_qty || 0),
        damaged_qty: Number(item.damaged_qty || 0),
        wrong_store_qty: Number(item.wrong_store_qty || 0),
        damage_reason: "",
      }
      return {
        ...prev,
        [orderId]: {
          ...orderEdits,
          [item.id]: {
            ...current,
            verified_qty: Math.max(0, current.verified_qty - 1),
            wrong_store_qty: current.wrong_store_qty + 1,
          },
        },
      }
    })

    setTouchedOrderIds((prev) => (prev.includes(orderId) ? prev : [...prev, orderId]))
  }

  useEffect(() => {
    if (!selectedOrderId) return
    const isStillSelectable = selectableOrders.some((order) => order.id === selectedOrderId)
    if (!isStillSelectable) {
      setSelectedOrderId("")
    }
  }, [selectedOrderId, selectableOrders])

  useEffect(() => {
    if (!open || !guidedScanAll) return

    const activeOrders = selectableOrders.filter((order) => getOrderMissingQty(order.id) > 0)
    if (activeOrders.length === 0) {
      setGuidedScanAll(false)
      setSelectedOrderId("")
      return
    }

    if (!selectedOrderId || !activeOrders.some((order) => order.id === selectedOrderId)) {
      const firstActive = activeOrders[0]
      setSelectedOrderId(firstActive.id)
      void ensureOrderDetails(firstActive.id)
      return
    }

    const currentMissing = getOrderMissingQty(selectedOrderId)
    if (currentMissing > 0) return

    const currentIndex = activeOrders.findIndex((order) => order.id === selectedOrderId)
    const nextOrder = activeOrders[currentIndex + 1] || activeOrders[0]
    if (nextOrder && nextOrder.id !== selectedOrderId) {
      setSelectedOrderId(nextOrder.id)
      void ensureOrderDetails(nextOrder.id)
    }
  }, [open, guidedScanAll, selectedOrderId, selectableOrders, orderDetailsById, itemEditsByOrder])

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Receive Assigned Products</DialogTitle>
            <DialogDescription>
              Scan products, review verification details, then click Save to update billing cart.
            </DialogDescription>
          </DialogHeader>

          {(() => {
            const selectedOrderPending = !!selectedOrderId && !orderDetailsById[selectedOrderId]
            const dialogBlockUI =
              !ordersInitialLoaded || !historyInitialLoaded || selectedOrderPending
            if (!dialogBlockUI) return null
            return (
              <div className="absolute inset-0 z-40 bg-white/85 backdrop-blur-sm flex items-center justify-center rounded-lg">
                <div className="flex flex-col items-center gap-3 text-center px-6 py-6 bg-white border rounded-xl shadow-xl">
                  <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                  <div>
                    <p className="font-semibold text-gray-900">Preparing verification dialog...</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {!ordersInitialLoaded
                        ? "Loading active orders"
                        : !historyInitialLoaded
                        ? "Loading verification history"
                        : "Loading selected order details"}
                    </p>
                  </div>
                </div>
              </div>
            )
          })()}

          {saving && (
            <div className="sticky top-0 z-30 -mx-6 -mt-2 mb-2 px-6 py-2 bg-gradient-to-r from-blue-500 via-indigo-500 to-blue-500 bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite] text-white shadow-md">
              <div className="flex items-center justify-center gap-3 text-sm font-medium">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Adding products to the store inventory...</span>
              </div>
              <style>{`@keyframes shimmer { 0% { background-position: 0% 0%; } 100% { background-position: 200% 0%; } }`}</style>
            </div>
          )}

          {inventoryFailures.length > 0 && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 space-y-1">
              <div className="font-semibold">Some products were not added to the store inventory:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                {inventoryFailures.map((failure, idx) => (
                  <li key={`${failure.order_id}-${failure.barcode}-${idx}`}>
                    <span className="font-medium">{failure.product_name}</span>
                    {" "}(barcode {failure.barcode}, order {failure.order_id}) - {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lastReconcileSummary && (
            <div
              className={`rounded-md border p-3 text-sm space-y-2 ${
                lastReconcileSummary.items_failed > 0
                  ? "border-red-300 bg-red-50 text-red-800"
                  : lastReconcileSummary.items_considered === 0
                  ? "border-slate-300 bg-slate-50 text-slate-700"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">
                  {lastReconcileSummary.items_considered === 0
                    ? "Nothing to reconcile"
                    : lastReconcileSummary.items_failed > 0
                    ? "Reconciled with failures"
                    : "Reconciliation complete"}
                </div>
                <button
                  type="button"
                  className="text-xs underline opacity-70 hover:opacity-100"
                  onClick={() => setLastReconcileSummary(null)}
                >
                  Dismiss
                </button>
              </div>
              <div className="text-xs opacity-80">
                Considered {lastReconcileSummary.items_considered}
                {" • "}Applied {lastReconcileSummary.items_applied}
                {" • "}Failed {lastReconcileSummary.items_failed}
                {" • "}Units pushed {lastReconcileSummary.delta_applied_total}
              </div>
              {lastReconcileSummary.items_considered === 0 ? (
                <div className="text-xs opacity-80">
                  Every verified item is already reflected in store inventory.
                </div>
              ) : (
                <ul className="list-disc pl-5 space-y-0.5">
                  {lastReconcileSummary.results.map((r, idx) => (
                    <li key={`${r.transfer_item_id || r.product_id || "row"}-${idx}`}>
                      <span className="font-medium">{r.product_name}</span>
                      {" "}— {r.success ? "+" : ""}{r.delta} unit{r.delta === 1 ? "" : "s"}
                      {" "}
                      <span className={r.success ? "text-emerald-700" : "text-red-700"}>
                        ({r.success ? "applied" : `failed${r.message ? `: ${r.message}` : ""}`})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Order Scope</Label>
              <Select
                value={selectedOrderId || AUTO_SCOPE}
                onValueChange={(value) => {
                  setGuidedScanAll(false)
                  setSelectedOrderId(value === AUTO_SCOPE ? "" : value)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={loadingOrders ? "Loading orders..." : "All Orders"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_SCOPE}>All Orders</SelectItem>
                  {selectableOrders.map((order) => (
                    <SelectItem key={order.id} value={order.id}>
                      {order.id} • {order.status} • Missing {getOrderMissingQty(order.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={guidedScanAll ? "secondary" : "outline"}
                  size="sm"
                  disabled={loadingOrders || selectableOrders.length === 0}
                  onClick={() => {
                    if (guidedScanAll) {
                      setGuidedScanAll(false)
                      return
                    }
                    setGuidedScanAll(true)
                    if (!selectedOrderId) {
                      const firstActive = selectableOrders[0]
                      if (firstActive) {
                        setSelectedOrderId(firstActive.id)
                        void ensureOrderDetails(firstActive.id)
                      }
                    }
                  }}
                >
                  {guidedScanAll ? "Stop Guided Scan" : "Scan All Orders (One by One)"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {guidedScanAll
                    ? selectedOrderId
                      ? `Guided mode active | Current order: ${selectedOrderId}`
                      : "Guided mode active | waiting for first active order"
                    : selectedOrderId
                      ? `Scanning order: ${selectedOrderId}`
                      : "Scanning all orders — barcode will auto-match the correct order."}
                </span>
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Order Summary</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <Badge variant="secondary">Assigned: {summary.assigned}</Badge>
                <Badge variant="secondary">Verified: {summary.verified}</Badge>
                <Badge variant="secondary">Damaged: {summary.damaged}</Badge>
                <Badge variant="secondary">Wrong Store: {summary.wrong}</Badge>
                <Badge variant="secondary">Missing: {summary.missing}</Badge>
              </CardContent>
            </Card>

            <Tabs value={activeViewTab} onValueChange={(value) => setActiveViewTab(value as "scan" | "history")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="scan">Scan</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>

              <TabsContent value="scan" className="mt-3">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Scan / Enter Barcode</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2 items-center">
                      <div className="relative flex-1">
                        <Input
                          ref={scanInputRef}
                          value={scanInput}
                          onChange={(e) => setScanInput(e.target.value)}
                          placeholder="Scan barcode or type manually"
                          disabled={loadingOrders || orders.length === 0 || scanningBarcode}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              handleBarcodeSubmit("scan")
                            }
                          }}
                        />
                        {scanningBarcode && (
                          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                        )}
                      </div>
                      <Button type="button" variant="outline" disabled={loadingOrders || orders.length === 0 || scanningBarcode} onClick={() => handleBarcodeSubmit("manual")}>
                        {scanningBarcode ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Press Enter after scanner input. In auto mode, barcode is matched to the correct order.
                    </p>

                    <div className="border rounded-lg p-3 min-h-[180px] space-y-2 bg-slate-50/60">
                      {visibleScanRows.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                          No scanned products yet.
                        </div>
                      ) : (
                        visibleScanRows.map((row) => (
                          <div
                            key={row.id}
                            className={`bg-white border rounded-md p-2 flex items-center justify-between gap-3 transition-all duration-300 ease-out ${
                              removingRowIds.has(row.id)
                                ? "opacity-0 -translate-x-6 scale-95"
                                : "opacity-100 translate-x-0 scale-100"
                            }`}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <ScanLine className={`h-4 w-4 ${row.status === "pending" ? "animate-pulse text-blue-600" : "text-slate-700"}`} />
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{row.product_name}</p>
                                <p className="text-xs text-muted-foreground truncate">{row.barcode}</p>
                                <p className="text-xs text-muted-foreground">Selling Price: {formatPrice(row.selling_price)}</p>
                                <p className="text-xs text-muted-foreground">
                                  Pending: {getPendingQtyForBarcodeInOrder(row.order_id, row.barcode)}
                                </p>
                                <p className="text-[11px] text-muted-foreground">Order: {row.order_id}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="outline">Qty {row.quantity}</Badge>
                              {getStatusBadge(row.status)}
                              {row.status !== "damaged" && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8">
                                      <MoreVertical className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => openDamagedConfirm(row.id)}>
                                      Damaged Product
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="history" className="mt-3">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Verification History</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {loadingHistory ? (
                      <div className="text-sm text-muted-foreground">Loading verification history...</div>
                    ) : historyOrdersWithVerifiedItems.length === 0 ? (
                      <div className="text-sm text-muted-foreground">No verification history yet.</div>
                    ) : (
                      historyOrdersWithVerifiedItems.map(({ orderId, verifiedItems, verifiedTotal, neededTotal }) => {
                        const isExpanded = !!expandedHistoryOrderIds[orderId]
                        return (
                          <div key={orderId} className="border rounded-md bg-slate-50/50">
                            <button
                              type="button"
                              onClick={() => toggleHistoryOrderExpanded(orderId)}
                              className="w-full p-3 flex items-center justify-between text-left"
                            >
                              <span className="font-medium text-sm inline-flex items-center gap-2">
                                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                Order: {orderId}
                              </span>
                              <span className="text-xs text-muted-foreground">Verified: {verifiedTotal} | Needed: {neededTotal}</span>
                            </button>
                            {isExpanded && (
                              <div className="px-3 pb-3 space-y-2">
                                {verifiedItems.map(({ item, verifiedQty }) => {
                                  const barcode = (item.products?.barcode || "").split(",")[0]?.trim() || "N/A"
                                  const lastVerified = item.last_verified_at || getLastVerifiedTimeForItem(orderId, item.id)
                                  return (
                                    <div key={item.id} className="bg-white border rounded-md p-2">
                                      <div className="min-w-0">
                                        <p className="text-sm font-medium truncate">{item.products?.name || item.product_id}</p>
                                        <p className="text-xs text-muted-foreground">Price: {formatPrice(getItemPrice(item))} | Barcode: {barcode}</p>
                                        <p className="text-xs text-muted-foreground">
                                          Verified Qty: {verifiedQty} | Last Verified: {lastVerified ? formatHistoryTime(lastVerified) : "N/A"}
                                        </p>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>

            {visibleOrderIds.map((orderId) => {
              const details = orderDetailsById[orderId]
              if (!details) return null
              return (
                <Card key={orderId}>
                  <CardHeader>
                    <CardTitle className="text-base">Assigned Items (Order: {orderId})</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {details.items.map((item) => {
                      const edit = itemEditsByOrder[orderId]?.[item.id]
                      const totalVerifiedQty = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
                      const totalDamagedQty = Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
                      const verifiedQty = Math.max(0, totalVerifiedQty - Number(item.verified_qty || 0))
                      const damagedQty = Math.max(0, totalDamagedQty - Number(item.damaged_qty || 0))
                      return (
                        <div key={item.id} className="border rounded-lg p-2 text-sm flex items-center justify-between">
                          <div>
                            <p className="font-medium">{item.products?.name || item.product_id}</p>
                            <p className="text-xs text-muted-foreground">Barcode: {item.products?.barcode || "N/A"}</p>
                            <p className="text-xs text-muted-foreground">
                              Price: {formatPrice(getItemPrice(item))}
                            </p>
                          </div>
                          <div className="text-xs text-right">
                            <p>Assigned: {item.assigned_qty}</p>
                            <p>Verified: {verifiedQty}</p>
                            <p>Damaged: {damagedQty}</p>
                          </div>
                        </div>
                      )
                    })}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <DialogFooter className="sticky bottom-0 z-20 border-t bg-background pt-3">
            <p className="text-xs text-muted-foreground mr-auto">
              {saving ? "Saving verification..." : canSave ? "Click Save to apply verification and refresh billing cart." : "Scan a product to start verification."}
            </p>
            <Button
              variant="outline"
              onClick={handleReconcileInventory}
              disabled={saving || reconciling}
              title="Re-apply any verified items that haven't made it into store inventory yet."
            >
              {reconciling ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Reconciling...
                </span>
              ) : (
                "Reconcile Inventory"
              )}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button onClick={() => handleSubmit({ closeOnSuccess: false })} disabled={saving || !canSave}>
              {saving ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </span>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDamagedRowId} onOpenChange={(nextOpen) => !nextOpen && setConfirmDamagedRowId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Damaged Product</DialogTitle>
            <DialogDescription>Are you sure this product unit is damaged?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDamagedRowId(null)}>
              No
            </Button>
            <Button variant="destructive" onClick={confirmDamagedProduct}>
              Yes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!scanErrorDialog} onOpenChange={(nextOpen) => !nextOpen && setScanErrorDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{scanErrorDialog?.title || "Scan Error"}</AlertDialogTitle>
            <AlertDialogDescription>{scanErrorDialog?.description || "Unable to process this barcode."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setScanErrorDialog(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

