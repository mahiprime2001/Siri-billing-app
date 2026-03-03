"use client"

import { useMemo, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
import { Badge } from "@/components/ui/badge"
import { Trash2, Search, ScanLine } from "lucide-react"
import { apiClient } from "@/lib/api-client"
import { useToast } from "@/hooks/use-toast"

interface ProductSearchResult {
  id: string
  name: string
  barcode?: string
  barcodes?: string
  stock?: number
}

interface SelectedItem {
  productId: string
  name: string
  barcode?: string
  quantity: number
  availableStock: number
}

interface ReturnToAdminDialogProps {
  isOpen: boolean
  onClose: () => void
}

const REASONS = [
  { value: "damaged", label: "Damaged" },
  { value: "modification", label: "Needs Modification" },
  { value: "low_sales", label: "Low Sales" },
]

const normalizeBarcode = (value: string) => value.trim().replace(/^0+/, "")

export default function ReturnToAdminDialog({ isOpen, onClose }: ReturnToAdminDialogProps) {
  const { toast } = useToast()
  const [barcodeInput, setBarcodeInput] = useState("")
  const [reasonType, setReasonType] = useState("")
  const [items, setItems] = useState<SelectedItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const canSubmit = items.length > 0 && !!reasonType && !isSubmitting

  const totalQty = useMemo(
    () => items.reduce((sum, item) => sum + (item.quantity || 0), 0),
    [items],
  )

  const resetForm = () => {
    setBarcodeInput("")
    setReasonType("")
    setItems([])
    setIsSearching(false)
    setIsSubmitting(false)
    setConfirmOpen(false)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const addOrIncrementItem = (product: ProductSearchResult): boolean => {
    const availableStock = Number.isFinite(Number(product.stock)) ? Math.max(0, Number(product.stock)) : 0

    if (availableStock <= 0) {
      toast({
        title: "Out of Stock",
        description: `${product.name} is not available in stock.`,
        variant: "destructive",
      })
      return false
    }

    const existing = items.find((item) => item.productId === product.id)
    if (existing) {
      if (existing.quantity >= existing.availableStock) {
        toast({
          title: "Stock Limit Reached",
          description: `No more stock available for ${product.name}.`,
          variant: "destructive",
        })
        return false
      }
      setItems((prev) =>
        prev.map((item) =>
          item.productId === product.id
            ? { ...item, quantity: item.quantity + 1, availableStock }
            : item,
        ),
      )
      return true
    }

    setItems((prev) => [
      ...prev,
      {
        productId: product.id,
        name: product.name,
        barcode: product.barcode || product.barcodes,
        quantity: 1,
        availableStock,
      },
    ])
    return true
  }

  const handleQtyChange = (productId: string, value: number) => {
    const next = Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1)
    const existing = items.find((item) => item.productId === productId)
    if (!existing) return

    if (next > existing.availableStock) {
      toast({
        title: "Stock Limit Reached",
        description: `Only ${existing.availableStock} available for ${existing.name}.`,
        variant: "destructive",
      })
      setItems((prev) =>
        prev.map((item) =>
          item.productId === productId ? { ...item, quantity: existing.availableStock } : item,
        ),
      )
      return
    }
    setItems((prev) =>
      prev.map((item) => (item.productId === productId ? { ...item, quantity: next } : item)),
    )
  }

  const handleSearch = async () => {
    const raw = barcodeInput.trim()
    if (!raw) {
      toast({
        title: "Barcode Required",
        description: "Enter or scan a barcode to continue.",
        variant: "destructive",
      })
      return
    }

    setIsSearching(true)
    try {
      const normalized = normalizeBarcode(raw)
      const response = await apiClient(`/api/products?search=${encodeURIComponent(normalized)}&limit=10`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const results = (await response.json()) as ProductSearchResult[]
      const match = (results || []).find((product) => {
        const candidates = [product.barcode, product.barcodes]
          .filter(Boolean)
          .flatMap((entry) => String(entry).split(","))
          .map((value) => normalizeBarcode(value))
        return candidates.includes(normalized)
      }) || results?.[0]

      if (!match) {
        toast({
          title: "Product Not Found",
          description: `No product found for barcode: ${raw}`,
          variant: "destructive",
        })
        return
      }

      const added = addOrIncrementItem(match)
      if (added) {
        setBarcodeInput("")
      }
    } catch (error) {
      console.error("Barcode search failed:", error)
      toast({
        title: "Search Failed",
        description: "Could not find product. Check connection and try again.",
        variant: "destructive",
      })
    } finally {
      setIsSearching(false)
    }
  }

  const handleRemove = (productId: string) => {
    setItems((prev) => prev.filter((item) => item.productId !== productId))
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const payload = {
        selectedItems: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
        reason: reasonType === "damaged" ? "Damaged" : reasonType === "modification" ? "Needs Modification" : "Low Sales",
        reasonType,
        damageOrigin: "store",
      }

      const response = await apiClient("/api/store-damage-returns", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(result?.message || `HTTP ${response.status}`)
      }

      toast({
        title: "Sent to Admin",
        description: `Submitted ${items.length} product(s) (Qty ${totalQty}).`,
      })
      handleClose()
    } catch (error) {
      console.error("Return to admin failed:", error)
      toast({
        title: "Submission Failed",
        description: (error as Error).message || "Failed to submit items.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
      setConfirmOpen(false)
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScanLine className="h-5 w-5" />
              Return to Admin
            </DialogTitle>
            <DialogDescription>
              Scan or enter product barcodes, select a reason, and send items back to admin.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex gap-2">
              <div className="flex-1">
                <Label htmlFor="return-barcode">Barcode</Label>
                <Input
                  id="return-barcode"
                  placeholder="Scan or enter barcode"
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      handleSearch()
                    }
                  }}
                />
              </div>
              <Button onClick={handleSearch} disabled={isSearching} className="mt-6">
                <Search className="h-4 w-4 mr-2" />
                {isSearching ? "Searching..." : "Add"}
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Reason</Label>
              <Select value={reasonType} onValueChange={setReasonType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select reason" />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead className="w-32">Qty</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                        No products added yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map((item) => (
                      <TableRow key={item.productId}>
                        <TableCell className="font-medium">{item.name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.barcode || "-"}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={1}
                            value={item.quantity}
                            onChange={(e) => handleQtyChange(item.productId, Number(e.target.value))}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemove(item.productId)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between">
              <Badge variant="secondary">Total Qty: {totalQty}</Badge>
              {!reasonType && items.length > 0 && (
                <span className="text-xs text-destructive">Reason is required.</span>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={!canSubmit}>
              Submit to Admin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Return to Admin</AlertDialogTitle>
            <AlertDialogDescription>
              This will submit {items.length} product(s) (Qty {totalQty}) to admin and reduce stock.
              Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? "Submitting..." : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
