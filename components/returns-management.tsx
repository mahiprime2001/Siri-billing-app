"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Package, User, Phone, Calendar, IndianRupee, CheckCircle, XCircle, Clock, RefreshCw, Plus, Info } from "lucide-react"
import { apiClient } from "@/lib/api-client"
import ReturnsDialog from "@/components/returns-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

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
  user?: { name: string; id: string; email: string; role: string } | null
}

export default function ReturnsManagement({ onCountChange, user }: ReturnsManagementProps = {}) {
  const [returns, setReturns] = useState<ReturnItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isReturnsDialogOpen, setIsReturnsDialogOpen] = useState(false)
  const { toast } = useToast()

  const fetchReturns = async () => {
    setIsLoading(true)
    try {
      const response = await apiClient('/api/returns')
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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="border-yellow-500 text-yellow-700"><Clock className="h-3 w-3 mr-1" /> Pending</Badge>
      case 'approved':
        return <Badge variant="outline" className="border-green-500 text-green-700"><CheckCircle className="h-3 w-3 mr-1" /> Approved</Badge>
      case 'denied':
        return <Badge variant="outline" className="border-red-500 text-red-700"><XCircle className="h-3 w-3 mr-1" /> Denied</Badge>
      default:
        return <Badge>{status}</Badge>
    }
  }

  const getUnitPrice = (returnItem: ReturnItem) => {
    if (returnItem.return_quantity > 0) {
      return returnItem.return_amount / returnItem.return_quantity
    }
    return 0
  }

  const pendingReturns = returns.filter(r => r.status === 'pending')
  const approvedReturns = returns.filter(r => r.status === 'approved')
  const deniedReturns = returns.filter(r => r.status === 'denied')

  const handleReturnDialogClose = () => {
    setIsReturnsDialogOpen(false)
    fetchReturns()
    if (onCountChange) onCountChange()
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading returns...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header with Create Return Button */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Return Requests</h2>
          <p className="text-muted-foreground">View and create product return requests</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setIsReturnsDialogOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            Create Return Request
          </Button>
          <Button onClick={fetchReturns} variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Info Alert */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Return Request Process</AlertTitle>
        <AlertDescription>
          Return requests created here will be reviewed and approved by the admin team. 
          You'll receive a notification once your request is processed.
        </AlertDescription>
      </Alert>

      {/* Pending Returns Section */}
      <Card>
        <CardHeader>
          <CardTitle>Pending Returns ({pendingReturns.length})</CardTitle>
          <CardDescription>Waiting for admin approval</CardDescription>
        </CardHeader>
        <CardContent>
          {pendingReturns.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No pending return requests</p>
          ) : (
            <div className="space-y-4">
              {pendingReturns.map((returnItem) => (
                <Card key={returnItem.return_id} className="border-l-4 border-l-yellow-500">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between mb-4">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-muted-foreground" />
                          <h3 className="font-semibold">{returnItem.product_name}</h3>
                          {getStatusBadge(returnItem.status)}
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {returnItem.customer_name || 'N/A'}
                          </span>
                          <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {returnItem.customer_phone_number || 'N/A'}
                          </span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          <span className="font-medium">Invoice:</span> {returnItem.bill_id}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          <span className="font-medium">Created by:</span> {returnItem.created_by}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          {new Date(returnItem.created_at).toLocaleString()}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="flex items-center gap-1 text-lg font-bold">
                          <IndianRupee className="h-4 w-4" />
                          {returnItem.return_amount.toFixed(2)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Return: {returnItem.return_quantity} of {returnItem.original_quantity}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Unit: ₹{getUnitPrice(returnItem).toFixed(2)}
                        </p>
                        <Badge variant="secondary" className="mt-2">
                          {returnItem.refund_method.toUpperCase()}
                        </Badge>
                      </div>
                    </div>

                    <div className="mt-3 p-3 bg-muted rounded-lg">
                      <p className="text-sm font-medium mb-1">Return Reason:</p>
                      <p className="text-sm text-muted-foreground">{returnItem.message}</p>
                    </div>

                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span>Awaiting admin approval</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Approved Returns Section */}
      <Card>
        <CardHeader>
          <CardTitle>Approved Returns ({approvedReturns.length})</CardTitle>
          <CardDescription>Returns approved by admin</CardDescription>
        </CardHeader>
        <CardContent>
          {approvedReturns.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No approved returns</p>
          ) : (
            <div className="space-y-4">
              {approvedReturns.map((returnItem) => (
                <Card key={returnItem.return_id} className="border-l-4 border-l-green-500">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{returnItem.product_name}</h3>
                          {getStatusBadge(returnItem.status)}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Customer: {returnItem.customer_name || 'N/A'}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Invoice: {returnItem.bill_id}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Returned: {returnItem.return_quantity} of {returnItem.original_quantity} items
                        </p>
                        <div className="text-sm text-muted-foreground">
                          <span className="font-medium">Submitted:</span> {new Date(returnItem.created_at).toLocaleDateString()}
                        </div>
                        {returnItem.approved_at && (
                          <div className="text-sm text-green-700 bg-green-50 p-2 rounded mt-2">
                            <CheckCircle className="h-3 w-3 inline mr-1" />
                            <span className="font-medium">Approved on:</span> {new Date(returnItem.approved_at).toLocaleString()}
                          </div>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="flex items-center gap-1 font-bold text-green-700">
                          <IndianRupee className="h-4 w-4" />
                          {returnItem.return_amount.toFixed(2)}
                        </div>
                        <p className="text-xs text-muted-foreground">Refund Amount</p>
                        <Badge variant="secondary" className="mt-2">
                          {returnItem.refund_method.toUpperCase()}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Denied Returns Section */}
      {deniedReturns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Denied Returns ({deniedReturns.length})</CardTitle>
            <CardDescription>Returns rejected by admin</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {deniedReturns.map((returnItem) => (
                <Card key={returnItem.return_id} className="border-l-4 border-l-red-500">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{returnItem.product_name}</h3>
                          {getStatusBadge(returnItem.status)}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Customer: {returnItem.customer_name || 'N/A'}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Invoice: {returnItem.bill_id}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Requested: {returnItem.return_quantity} of {returnItem.original_quantity} items
                        </p>
                        <div className="text-sm text-muted-foreground">
                          <span className="font-medium">Submitted:</span> {new Date(returnItem.created_at).toLocaleDateString()}
                        </div>
                        {returnItem.denied_at && (
                          <div className="text-sm text-muted-foreground">
                            <span className="font-medium">Denied on:</span> {new Date(returnItem.denied_at).toLocaleString()}
                          </div>
                        )}
                        {returnItem.denial_reason && (
                          <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded">
                            <p className="text-sm font-medium text-red-800 flex items-center gap-1">
                              <XCircle className="h-3 w-3" />
                              Denial Reason:
                            </p>
                            <p className="text-sm text-red-700 mt-1">{returnItem.denial_reason}</p>
                          </div>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="flex items-center gap-1 font-bold text-red-700">
                          <IndianRupee className="h-4 w-4" />
                          {returnItem.return_amount.toFixed(2)}
                        </div>
                        <p className="text-xs text-muted-foreground">Requested Amount</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Returns Dialog for Creating New Return Requests */}
      {user && (
        <ReturnsDialog
          isOpen={isReturnsDialogOpen}
          onClose={handleReturnDialogClose}
          user={user}
        />
      )}
    </div>
  )
}
