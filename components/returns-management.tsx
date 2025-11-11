"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { Package, User, Phone, Calendar, IndianRupee, CheckCircle, XCircle, Clock, FileText, RefreshCw } from "lucide-react"
import { apiClient } from "@/lib/api-client"

interface ReturnItem {
  return_id: string
  product_name: string
  product_id: string
  customer_name: string
  customer_phone_number: string
  message: string
  refund_method: string
  bill_id: string
  item_index: number
  original_quantity: number
  return_quantity: number
  unit_price: number
  return_amount: number
  status: 'pending' | 'approved' | 'denied'
  created_by: string
  created_at: string
  updated_at: string
  approved_by?: string
  approved_at?: string
  denied_by?: string
  denied_at?: string
  denial_reason?: string
}

interface ReturnsManagementProps {
  onCountChange?: () => void
}

export default function ReturnsManagement({ onCountChange }: ReturnsManagementProps = {}) {
  const [returns, setReturns] = useState<ReturnItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedReturn, setSelectedReturn] = useState<ReturnItem | null>(null)
  const [isDenyDialogOpen, setIsDenyDialogOpen] = useState(false)
  const [denialReason, setDenialReason] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const { toast } = useToast()

  const fetchReturns = async () => {
    setIsLoading(true)
    try {
      const response = await apiClient('/api/returns/list')
      if (!response.ok) {
        throw new Error('Failed to fetch returns')
      }
      const data = await response.json()
      setReturns(data)
    } catch (error) {
      console.error("Error fetching returns:", error)
      toast({
        title: "Error",
        description: "Failed to load return requests",
        variant: "destructive",
      })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchReturns()
  }, [])

  const handleApprove = async (returnItem: ReturnItem) => {
    setIsProcessing(true)
    try {
      const response = await apiClient(`/api/returns/${returnItem.return_id}/approve`, {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error('Failed to approve return')
      }

      toast({
        title: "Return Approved",
        description: `Return request for ${returnItem.product_name} has been approved`,
      })

      // Refresh the list and notify parent
      await fetchReturns()
      if (onCountChange) onCountChange()
    } catch (error) {
      console.error("Error approving return:", error)
      toast({
        title: "Error",
        description: "Failed to approve return request",
        variant: "destructive",
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleDenyClick = (returnItem: ReturnItem) => {
    setSelectedReturn(returnItem)
    setDenialReason("")
    setIsDenyDialogOpen(true)
  }

  const handleDenyConfirm = async () => {
    if (!selectedReturn) return

    if (!denialReason.trim()) {
      toast({
        title: "Reason Required",
        description: "Please provide a reason for denying this return",
        variant: "destructive",
      })
      return
    }

    setIsProcessing(true)
    try {
      const response = await apiClient(`/api/returns/${selectedReturn.return_id}/deny`, {
        method: 'POST',
        body: JSON.stringify({ reason: denialReason }),
      })

      if (!response.ok) {
        throw new Error('Failed to deny return')
      }

      toast({
        title: "Return Denied",
        description: `Return request for ${selectedReturn.product_name} has been denied`,
      })

      // Close dialog, refresh the list, and notify parent
      setIsDenyDialogOpen(false)
      setSelectedReturn(null)
      setDenialReason("")
      await fetchReturns()
      if (onCountChange) onCountChange()
    } catch (error) {
      console.error("Error denying return:", error)
      toast({
        title: "Error",
        description: "Failed to deny return request",
        variant: "destructive",
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-300"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
      case 'approved':
        return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>
      case 'denied':
        return <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300"><XCircle className="h-3 w-3 mr-1" />Denied</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  const pendingReturns = returns.filter(r => r.status === 'pending')
  const processedReturns = returns.filter(r => r.status !== 'pending')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <RefreshCw className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-600">Loading returns...</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header with Refresh */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Return Requests</h2>
          <p className="text-sm text-muted-foreground">Manage product return requests</p>
        </div>
        <Button onClick={fetchReturns} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Pending Returns Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-yellow-600" />
            Pending Returns ({pendingReturns.length})
          </CardTitle>
          <CardDescription>Return requests awaiting approval or denial</CardDescription>
        </CardHeader>
        <CardContent>
          {pendingReturns.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No pending return requests</p>
          ) : (
            <div className="space-y-4">
              {pendingReturns.map((returnItem) => (
                <Card key={returnItem.return_id} className="border-2 border-yellow-200">
                  <CardContent className="pt-6">
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <Package className="h-5 w-5 text-gray-600" />
                          <h3 className="text-lg font-semibold">{returnItem.product_name}</h3>
                          {getStatusBadge(returnItem.status)}
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground mt-3">
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4" />
                            <span>{returnItem.customer_name || 'N/A'}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4" />
                            <span>{returnItem.customer_phone_number || 'N/A'}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4" />
                            <span>Invoice: {returnItem.bill_id}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Calendar className="h-4 w-4" />
                            <span>{new Date(returnItem.created_at).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>
                      <div className="text-right ml-4">
                        <div className="text-2xl font-bold text-primary flex items-center justify-end">
                          <IndianRupee className="h-5 w-5" />
                          {returnItem.return_amount.toFixed(2)}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {returnItem.return_quantity} × ₹{returnItem.unit_price.toFixed(2)}
                        </div>
                        <Badge variant="secondary" className="mt-2">
                          {returnItem.refund_method.toUpperCase()}
                        </Badge>
                      </div>
                    </div>

                    <Separator className="my-3" />

                    <div className="mb-4">
                      <Label className="text-sm font-semibold">Return Reason:</Label>
                      <p className="text-sm text-muted-foreground mt-1 bg-gray-50 p-3 rounded-md">
                        {returnItem.message}
                      </p>
                    </div>

                    <div className="flex gap-2 justify-end">
                      <Button
                        onClick={() => handleDenyClick(returnItem)}
                        variant="outline"
                        className="border-red-300 text-red-700 hover:bg-red-50"
                        disabled={isProcessing}
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Deny
                      </Button>
                      <Button
                        onClick={() => handleApprove(returnItem)}
                        className="bg-green-600 hover:bg-green-700"
                        disabled={isProcessing}
                      >
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Approve
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Processed Returns Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-gray-600" />
            Processed Returns ({processedReturns.length})
          </CardTitle>
          <CardDescription>Previously approved or denied return requests</CardDescription>
        </CardHeader>
        <CardContent>
          {processedReturns.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No processed returns</p>
          ) : (
            <div className="space-y-3">
              {processedReturns.map((returnItem) => (
                <Card key={returnItem.return_id} className="border">
                  <CardContent className="pt-4">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <Package className="h-4 w-4 text-gray-600" />
                          <h4 className="font-semibold">{returnItem.product_name}</h4>
                          {getStatusBadge(returnItem.status)}
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                          <span>Customer: {returnItem.customer_name || 'N/A'}</span>
                          <span>Invoice: {returnItem.bill_id}</span>
                          <span>Date: {new Date(returnItem.created_at).toLocaleDateString()}</span>
                        </div>
                        {returnItem.denial_reason && (
                          <div className="mt-2 text-xs">
                            <span className="font-semibold text-red-700">Denial Reason: </span>
                            <span className="text-muted-foreground">{returnItem.denial_reason}</span>
                          </div>
                        )}
                      </div>
                      <div className="text-right ml-4">
                        <div className="font-bold text-primary flex items-center justify-end">
                          <IndianRupee className="h-4 w-4" />
                          {returnItem.return_amount.toFixed(2)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Qty: {returnItem.return_quantity}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deny Dialog */}
      <Dialog open={isDenyDialogOpen} onOpenChange={setIsDenyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deny Return Request</DialogTitle>
            <DialogDescription>
              Please provide a reason for denying this return request.
            </DialogDescription>
          </DialogHeader>
          
          {selectedReturn && (
            <div className="space-y-4">
              <div className="bg-gray-50 p-3 rounded-md">
                <p className="text-sm font-semibold">{selectedReturn.product_name}</p>
                <p className="text-xs text-muted-foreground">
                  Customer: {selectedReturn.customer_name} | Amount: ₹{selectedReturn.return_amount.toFixed(2)}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="denial-reason">Denial Reason *</Label>
                <Textarea
                  id="denial-reason"
                  placeholder="Explain why this return is being denied..."
                  value={denialReason}
                  onChange={(e) => setDenialReason(e.target.value)}
                  rows={4}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDenyDialogOpen(false)} disabled={isProcessing}>
              Cancel
            </Button>
            <Button 
              onClick={handleDenyConfirm} 
              className="bg-red-600 hover:bg-red-700"
              disabled={isProcessing}
            >
              {isProcessing ? 'Processing...' : 'Confirm Denial'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
