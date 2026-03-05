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
  }
}

type TransferOrderDetails = {
  id: string
  status: string
  items: TransferItem[]
}

type ScanRow = {
  id: string
  transfer_item_id: string
  barcode: string
  product_name: string
  quantity: number
  status: "pending" | "verified" | "damaged"
  entry_mode: "scan" | "manual"
}

type ScanLog = {
  transfer_item_id: string
  barcode: string
  quantity: number
  entry_mode: "scan" | "manual"
  event_type: "verified" | "damaged"
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onVerificationSaved?: () => void
}

const normalizeBarcode = (value: string) => value.trim().replace(/^0+/, "")

export default function TransferVerificationDialog({ open, onOpenChange, onVerificationSaved }: Props) {
  const { toast } = useToast()
  const scanInputRef = useRef<HTMLInputElement | null>(null)
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([])

  const [loadingOrders, setLoadingOrders] = useState(false)
  const [orders, setOrders] = useState<TransferOrder[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>("")
  const [orderDetails, setOrderDetails] = useState<TransferOrderDetails | null>(null)
  const [saving, setSaving] = useState(false)
  const [scanInput, setScanInput] = useState("")
  const [scanRows, setScanRows] = useState<ScanRow[]>([])
  const [scanLogs, setScanLogs] = useState<ScanLog[]>([])
  const [confirmDamagedRowId, setConfirmDamagedRowId] = useState<string | null>(null)
  const [scanErrorDialog, setScanErrorDialog] = useState<{ title: string; description: string } | null>(null)
  const [itemEdits, setItemEdits] = useState<
    Record<string, { verified_qty: number; damaged_qty: number; wrong_store_qty: number; damage_reason?: string }>
  >({})

  const clearAnimationTimers = () => {
    timerRefs.current.forEach((id) => clearTimeout(id))
    timerRefs.current = []
  }

  const loadOrders = async () => {
    setLoadingOrders(true)
    try {
      const response = await apiClient("/api/stores/current/transfer-orders")
      if (!response.ok) throw new Error("Failed to fetch transfer orders")
      const data = (await response.json()) as TransferOrder[]
      setOrders(data)
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

  const loadOrderDetails = async (orderId: string) => {
    try {
      const response = await apiClient(`/api/transfer-orders/${orderId}`)
      if (!response.ok) throw new Error("Failed to fetch order details")
      const data = (await response.json()) as TransferOrderDetails
      setOrderDetails(data)
      const initialEdits: Record<
        string,
        { verified_qty: number; damaged_qty: number; wrong_store_qty: number; damage_reason?: string }
      > = {}
      data.items.forEach((item) => {
        initialEdits[item.id] = {
          verified_qty: Number(item.verified_qty || 0),
          damaged_qty: Number(item.damaged_qty || 0),
          wrong_store_qty: Number(item.wrong_store_qty || 0),
          damage_reason: "",
        }
      })
      setItemEdits(initialEdits)
      setScanRows([])
      setScanLogs([])
      setScanInput("")
      setConfirmDamagedRowId(null)
    } catch (error) {
      console.error("Error loading transfer order details:", error)
      toast({
        title: "Load Failed",
        description: "Could not fetch selected order details.",
        variant: "destructive",
      })
    }
  }

  useEffect(() => {
    if (open) {
      setSelectedOrderId("")
      setOrderDetails(null)
      setItemEdits({})
      setScanRows([])
      setScanLogs([])
      setScanInput("")
      setConfirmDamagedRowId(null)
      clearAnimationTimers()
      loadOrders()
    }
    return () => {
      clearAnimationTimers()
    }
  }, [open])

  useEffect(() => {
    if (selectedOrderId) {
      loadOrderDetails(selectedOrderId)
    } else {
      setOrderDetails(null)
      setItemEdits({})
      setScanRows([])
      setScanLogs([])
      setScanInput("")
      setConfirmDamagedRowId(null)
      clearAnimationTimers()
    }
  }, [selectedOrderId])

  useEffect(() => {
    if (orderDetails) {
      scanInputRef.current?.focus()
    }
  }, [orderDetails])

  const summary = useMemo(() => {
    if (!orderDetails) {
      return { assigned: 0, verified: 0, damaged: 0, wrong: 0, missing: 0 }
    }
    let assigned = 0
    let verified = 0
    let damaged = 0
    let wrong = 0
    orderDetails.items.forEach((item) => {
      const edit = itemEdits[item.id]
      assigned += Number(item.assigned_qty || 0)
      verified += Number(edit?.verified_qty ?? item.verified_qty ?? 0)
      damaged += Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
      wrong += Number(edit?.wrong_store_qty ?? item.wrong_store_qty ?? 0)
    })
    const missing = Math.max(0, assigned - verified - damaged - wrong)
    return { assigned, verified, damaged, wrong, missing }
  }, [orderDetails, itemEdits])

  const findMatchingItem = (enteredBarcode: string): TransferItem | null => {
    if (!orderDetails) return null
    const normalized = normalizeBarcode(enteredBarcode)
    return (
      orderDetails.items.find((item) => {
        const barcodes = (item.products?.barcode || "")
          .split(",")
          .map((code) => normalizeBarcode(code))
          .filter(Boolean)
        return barcodes.includes(normalized)
      }) || null
    )
  }

  const scheduleStatusToVerified = (rowId: string) => {
    const timerId = setTimeout(() => {
      setScanRows((prev) => prev.map((row) => (row.id === rowId && row.status === "pending" ? { ...row, status: "verified" } : row)))
    }, 700)
    timerRefs.current.push(timerId)
  }

  const incrementVerified = (item: TransferItem, barcode: string, entryMode: "scan" | "manual") => {
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
    setItemEdits((prev) => {
      const current = prev[item.id] || {
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
        [item.id]: {
          ...current,
          verified_qty: current.verified_qty + 1,
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

    const rowId = `verified-${item.id}`
    setScanRows((prev) => {
      const existingIndex = prev.findIndex((row) => row.id === rowId)
      if (existingIndex >= 0) {
        const next = [...prev]
        next[existingIndex] = {
          ...next[existingIndex],
          quantity: next[existingIndex].quantity + 1,
          status: "pending",
          entry_mode: entryMode,
          barcode: item.products?.barcode || barcode,
        }
        return next
      }
      return [
        {
          id: rowId,
          transfer_item_id: item.id,
          barcode: item.products?.barcode || barcode,
          product_name: item.products?.name || item.product_id,
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
        transfer_item_id: item.id,
        barcode,
        quantity: 1,
        entry_mode: entryMode,
        event_type: "verified",
      },
    ])

    scheduleStatusToVerified(rowId)
  }

  const handleBarcodeSubmit = (entryMode: "scan" | "manual") => {
    const entered = scanInput.trim()
    if (!entered) return

    const matchedItem = findMatchingItem(entered)
    if (!matchedItem) {
      setScanInput("")
      setScanErrorDialog({
        title: "Wrong Stock",
        description: "This barcode does not belong to this transfer order/store.",
      })
      return
    }

    incrementVerified(matchedItem, entered, entryMode)
    setScanInput("")
    scanInputRef.current?.focus()
  }

  const openDamagedConfirm = (rowId: string) => {
    setConfirmDamagedRowId(rowId)
  }

  const confirmDamagedProduct = () => {
    if (!confirmDamagedRowId || !orderDetails) return

    const row = scanRows.find((entry) => entry.id === confirmDamagedRowId)
    if (!row || row.quantity <= 0 || row.status === "damaged") {
      setConfirmDamagedRowId(null)
      return
    }

    const item = orderDetails.items.find((entry) => entry.id === row.transfer_item_id)
    if (!item) {
      setConfirmDamagedRowId(null)
      return
    }

    setItemEdits((prev) => {
      const current = prev[item.id] || {
        verified_qty: Number(item.verified_qty || 0),
        damaged_qty: Number(item.damaged_qty || 0),
        wrong_store_qty: Number(item.wrong_store_qty || 0),
        damage_reason: "",
      }
      return {
        ...prev,
        [item.id]: {
          ...current,
          verified_qty: Math.max(0, current.verified_qty - 1),
          damaged_qty: current.damaged_qty + 1,
          damage_reason: "Marked damaged during receive scan",
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

      const damagedRowId = `damaged-${row.transfer_item_id}`
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
        transfer_item_id: row.transfer_item_id,
        barcode: row.barcode,
        quantity: 1,
        entry_mode: row.entry_mode,
        event_type: "damaged",
      },
    ])

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

  const handleSubmit = async () => {
    if (!selectedOrderId || !orderDetails) return
    const verificationSessionId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `ver-${Date.now()}`

    const payloadItems = orderDetails.items.map((item) => {
      const edit = itemEdits[item.id] || {
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

    setSaving(true)
    try {
      const response = await apiClient(`/api/transfer-orders/${selectedOrderId}/verify`, {
        method: "POST",
        body: JSON.stringify({
          verification_session_id: verificationSessionId,
          items: payloadItems,
          scans: scanLogs,
        }),
      })

      const result = await response.json()
      if (!response.ok) {
        throw new Error(result?.message || "Failed to submit verification")
      }

      toast({
        title: "Verification Saved",
        description:
          result?.status === "duplicate_ignored"
            ? "Duplicate session ignored safely."
            : `Order updated (${result?.order_status || "in_progress"}).`,
      })

      // Only verified qty is applied into store inventory by backend.
      await loadOrders()
      await loadOrderDetails(selectedOrderId)
      onOpenChange(false)
      onVerificationSaved?.()
    } catch (error) {
      console.error("Error saving transfer verification:", error)
      toast({
        title: "Save Failed",
        description: (error as Error).message || "Could not save verification.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Receive Assigned Products</DialogTitle>
            <DialogDescription>
              Select order, scan or type product barcode, then submit verification.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Select Transfer Order</Label>
              <Select value={selectedOrderId} onValueChange={setSelectedOrderId}>
                <SelectTrigger>
                  <SelectValue placeholder={loadingOrders ? "Loading orders..." : "Select pending order"} />
                </SelectTrigger>
                <SelectContent>
                  {orders.map((order) => (
                    <SelectItem key={order.id} value={order.id}>
                      {order.id} • {order.status} • Missing {order.missing_qty_total ?? 0}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {orderDetails && (
              <>
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
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            handleBarcodeSubmit("scan")
                          }
                        }}
                      />
                      <Button type="button" variant="outline" onClick={() => handleBarcodeSubmit("manual")}>
                        Add
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Press Enter after scanner input. For manual entry, type barcode and click Add.
                    </p>

                    <div className="border rounded-lg p-3 min-h-[180px] space-y-2 bg-slate-50/60">
                      {scanRows.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                          No scanned products yet.
                        </div>
                      ) : (
                        scanRows.map((row) => (
                          <div key={row.id} className="bg-white border rounded-md p-2 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <ScanLine className={`h-4 w-4 ${row.status === "pending" ? "animate-pulse text-blue-600" : "text-slate-700"}`} />
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{row.product_name}</p>
                                <p className="text-xs text-muted-foreground truncate">{row.barcode}</p>
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

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Assigned Items (Reference)</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {orderDetails.items.map((item) => {
                      const edit = itemEdits[item.id]
                      const verifiedQty = Number(edit?.verified_qty ?? item.verified_qty ?? 0)
                      const damagedQty = Number(edit?.damaged_qty ?? item.damaged_qty ?? 0)
                      return (
                        <div key={item.id} className="border rounded-lg p-2 text-sm flex items-center justify-between">
                          <div>
                            <p className="font-medium">{item.products?.name || item.product_id}</p>
                            <p className="text-xs text-muted-foreground">Barcode: {item.products?.barcode || "N/A"}</p>
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
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button onClick={handleSubmit} disabled={!orderDetails || saving}>
              {saving ? "Saving..." : "Submit Verification"}
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
