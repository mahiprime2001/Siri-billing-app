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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { apiClient } from "@/lib/api-client"
import { Loader2, MoreVertical, ScanLine } from "lucide-react"

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
  barcode: string
  quantity: number
  entry_mode: "scan" | "manual"
  event_type: "verified" | "damaged"
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
  const autoSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoSubmitSignatureRef = useRef("")

  const [loadingOrders, setLoadingOrders] = useState(false)
  const [loadingOrderDetails, setLoadingOrderDetails] = useState(false)
  const [orders, setOrders] = useState<TransferOrder[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>("")
  const [orderDetailsById, setOrderDetailsById] = useState<Record<string, TransferOrderDetails>>({})
  const [itemEditsByOrder, setItemEditsByOrder] = useState<Record<string, Record<string, ItemEdit>>>({})
  const [saving, setSaving] = useState(false)
  const [scanInput, setScanInput] = useState("")
  const [scanRows, setScanRows] = useState<ScanRow[]>([])
  const [scanLogs, setScanLogs] = useState<ScanLog[]>([])
  const [touchedOrderIds, setTouchedOrderIds] = useState<string[]>([])
  const [confirmDamagedRowId, setConfirmDamagedRowId] = useState<string | null>(null)
  const [scanErrorDialog, setScanErrorDialog] = useState<{ title: string; description: string } | null>(null)

  const clearAnimationTimers = () => {
    timerRefs.current.forEach((id) => clearTimeout(id))
    timerRefs.current = []
    if (autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current)
      autoSubmitTimerRef.current = null
    }
  }

  const clearSubmissionBuffers = () => {
    setScanLogs([])
    setTouchedOrderIds([])
    lastAutoSubmitSignatureRef.current = ""
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

  const preloadOrderDetails = async (orderList: TransferOrder[]) => {
    if (!orderList.length) {
      setOrderDetailsById({})
      setItemEditsByOrder({})
      return
    }

    setLoadingOrderDetails(true)
    try {
      const detailResults = await Promise.allSettled(orderList.map((order) => loadOrderDetails(order.id)))
      const detailMap: Record<string, TransferOrderDetails> = {}
      const editsMap: Record<string, Record<string, ItemEdit>> = {}

      detailResults.forEach((result, idx) => {
        if (result.status === "fulfilled") {
          const details = result.value
          detailMap[details.id] = details
          editsMap[details.id] = createInitialEdits(details)
        } else {
          console.error("Error loading transfer order details:", orderList[idx]?.id, result.reason)
        }
      })

      setOrderDetailsById(detailMap)
      setItemEditsByOrder(editsMap)
    } finally {
      setLoadingOrderDetails(false)
    }
  }

  const loadOrders = async () => {
    setLoadingOrders(true)
    try {
      const response = await apiClient("/api/stores/current/transfer-orders")
      if (!response.ok) throw new Error("Failed to fetch transfer orders")
      const data = (await response.json()) as TransferOrder[]
      setOrders(data)
      await preloadOrderDetails(data)
    } catch (error) {
      console.error("Error loading transfer orders:", error)
      toast({
        title: "Load Failed",
        description: "Could not fetch transfer orders.",
        variant: "destructive",
      })
    } finally {
      setLoadingOrders(false)
    }
  }

  useEffect(() => {
    if (open) {
      setSelectedOrderId(initialSelectedOrderId || "")
      setOrderDetailsById({})
      setItemEditsByOrder({})
      setScanRows([])
      setScanLogs([])
      setTouchedOrderIds([])
      setScanInput("")
      setConfirmDamagedRowId(null)
      clearAnimationTimers()
      lastAutoSubmitSignatureRef.current = ""
      loadOrders()
    }
    return () => {
      clearAnimationTimers()
    }
  }, [open, initialSelectedOrderId])

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

  const summary = useMemo(() => {
    let assigned = 0
    let verified = 0
    let damaged = 0
    let wrong = 0

    selectedOrderIds.forEach((orderId) => {
      const details = orderDetailsById[orderId]
      if (!details) return
      details.items.forEach((item) => {
        const edit = itemEditsByOrder[orderId]?.[item.id]
        assigned += Number(item.assigned_qty || 0)
        verified += Number(edit?.verified_qty ?? item.verified_qty ?? 0)
        damaged += Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
        wrong += Number(edit?.wrong_store_qty ?? item.wrong_store_qty ?? 0)
      })
    })

    const missing = Math.max(0, assigned - verified - damaged - wrong)
    return { assigned, verified, damaged, wrong, missing }
  }, [selectedOrderIds, orderDetailsById, itemEditsByOrder])

  const findMatchingItem = (enteredBarcode: string): { orderId: string; item: TransferItem } | null => {
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

    if (pendingMatches.length === 0) return null
    if (pendingMatches.length === 1) return pendingMatches[0]

    // If the same barcode exists in multiple orders, auto-pick oldest order first.
    const orderPriority = new Map(
      [...orders]
        .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
        .map((order, idx) => [order.id, idx]),
    )

    return [...pendingMatches].sort((a, b) => {
      const aPriority = orderPriority.get(a.orderId) ?? Number.MAX_SAFE_INTEGER
      const bPriority = orderPriority.get(b.orderId) ?? Number.MAX_SAFE_INTEGER
      return aPriority - bPriority
    })[0]
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
      setScanErrorDialog({
        title: "Stock Fully Scanned",
        description: "Assigned quantity for this product is already completed. No more units can be scanned.",
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
        barcode,
        quantity: 1,
        entry_mode: entryMode,
        event_type: "verified",
      },
    ])

    setTouchedOrderIds((prev) => (prev.includes(orderId) ? prev : [...prev, orderId]))
    scheduleStatusToVerified(rowId)
  }

  const handleBarcodeSubmit = (entryMode: "scan" | "manual") => {
    const entered = scanInput.trim()
    if (!entered) return

    const match = findMatchingItem(entered)
    if (!match) {
      setScanInput("")
      setScanErrorDialog({
        title: "Wrong Stock",
        description: "This barcode does not belong to your active transfer orders.",
      })
      return
    }

    incrementVerified(match.orderId, match.item, entered, entryMode)
    setScanInput("")
    scanInputRef.current?.focus()
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
        barcode: row.barcode,
        quantity: 1,
        entry_mode: row.entry_mode,
        event_type: "damaged",
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

          if (successCount > 0 && failedCount === 0) {
            if (!silentSuccess) {
              toast({
                title: "Verification Saved",
                description: `Updated ${successCount} order${successCount > 1 ? "s" : ""}.`,
              })
            }
            clearSubmissionBuffers()
            if (closeOnSuccess) {
              onOpenChange(false)
            }
            onVerificationSaved?.()
            return
          }

          if (successCount > 0 && failedCount > 0) {
            toast({
              title: "Partially Saved",
              description: `Saved ${successCount} order(s). Failed ${failedCount} order(s).`,
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
        clearSubmissionBuffers()
        if (closeOnSuccess) {
          onOpenChange(false)
        }
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

  const hasPendingAnimation = useMemo(() => scanRows.some((row) => row.status === "pending"), [scanRows])
  const autoSubmitSignature = useMemo(() => {
    if (!touchedOrderIds.length) return ""
    const orderSignature = [...touchedOrderIds].sort().join(",")
    const scanSignature = scanLogs
      .map((scan) => `${scan.order_id}:${scan.transfer_item_id}:${scan.event_type}:${scan.quantity}`)
      .join("|")
    return `${orderSignature}::${scanSignature}`
  }, [touchedOrderIds, scanLogs])

  useEffect(() => {
    if (!open || saving || hasPendingAnimation || !autoSubmitSignature) return
    if (lastAutoSubmitSignatureRef.current === autoSubmitSignature) return

    if (autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current)
    }

    autoSubmitTimerRef.current = setTimeout(() => {
      lastAutoSubmitSignatureRef.current = autoSubmitSignature
      handleSubmit({ closeOnSuccess: false, silentSuccess: true })
    }, 180)

    return () => {
      if (autoSubmitTimerRef.current) {
        clearTimeout(autoSubmitTimerRef.current)
        autoSubmitTimerRef.current = null
      }
    }
  }, [open, saving, hasPendingAnimation, autoSubmitSignature])

  const canAutoSave = touchedOrderIds.length > 0

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

  const selectableOrders = orders.filter((order) => getOrderMissingQty(order.id) > 0)

  useEffect(() => {
    if (!selectedOrderId) return
    const isStillSelectable = selectableOrders.some((order) => order.id === selectedOrderId)
    if (!isStillSelectable) {
      setSelectedOrderId("")
    }
  }, [selectedOrderId, selectableOrders])

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Receive Assigned Products</DialogTitle>
            <DialogDescription>
              Scan first and verify. Once animation completes, verification is auto-saved.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Order Scope (Optional)</Label>
              <Select value={selectedOrderId || AUTO_SCOPE} onValueChange={(value) => setSelectedOrderId(value === AUTO_SCOPE ? "" : value)}>
                <SelectTrigger>
                  <SelectValue placeholder={loadingOrders ? "Loading orders..." : "All active orders (auto)"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_SCOPE}>All active orders (auto)</SelectItem>
                  {selectableOrders.map((order) => (
                    <SelectItem key={order.id} value={order.id}>
                      {order.id} • {order.status} • Missing {getOrderMissingQty(order.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Scan / Enter Barcode</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    ref={scanInputRef}
                    value={scanInput}
                    onChange={(e) => setScanInput(e.target.value)}
                    placeholder="Scan barcode or type manually"
                    disabled={loadingOrderDetails || orders.length === 0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        handleBarcodeSubmit("scan")
                      }
                    }}
                  />
                  <Button type="button" variant="outline" disabled={loadingOrderDetails || orders.length === 0} onClick={() => handleBarcodeSubmit("manual")}>
                    Add
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
                      <div key={row.id} className="bg-white border rounded-md p-2 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <ScanLine className={`h-4 w-4 ${row.status === "pending" ? "animate-pulse text-blue-600" : "text-slate-700"}`} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{row.product_name}</p>
                            <p className="text-xs text-muted-foreground truncate">{row.barcode}</p>
                            <p className="text-xs text-muted-foreground">Selling Price: {formatPrice(row.selling_price)}</p>
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

            {selectedOrderIds.map((orderId) => {
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
                      const verifiedQty = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
                      const damagedQty = Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
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
              {saving ? "Saving verification..." : canAutoSave ? "Verification will save automatically after scan animation." : "Scan a product to start verification."}
            </p>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
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
