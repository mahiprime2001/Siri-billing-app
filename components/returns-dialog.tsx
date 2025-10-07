"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/hooks/use-toast"
import { Search, ArrowLeft, Package, User, Phone, CreditCard, Clock, IndianRupee } from "lucide-react"

interface BillItem {
  productId: string
  productName: string
  price: number
  quantity: number
  total: number
}

interface Bill {
  id: string
  customerName?: string
  customerPhone?: string
  items: BillItem[]
  paymentMethod: string
  total: number
  timestamp: string
}

interface ReturnRequest {
  searchQuery: string
  searchType: 'customer' | 'phone' | 'invoice'
  selectedItems: string[]
  returnReason: string
  refundMethod: 'cash' | 'upi'
}

interface ReturnsDialogProps {
  isOpen: boolean
  onClose: () => void
  user: { name: string } | null
}

export default function ReturnsDialog({ isOpen, onClose, user }: ReturnsDialogProps) {
  const [returnRequest, setReturnRequest] = useState<ReturnRequest>({
    searchQuery: '',
    searchType: 'customer',
    selectedItems: [],
    returnReason: '',
    refundMethod: 'cash'
  })
  const [searchResults, setSearchResults] = useState<Bill[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showReturnForm, setShowReturnForm] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  const { toast } = useToast()

  const handleSearch = async () => {
    if (!returnRequest.searchQuery.trim()) {
      toast({
        title: "Search Required",
        description: "Please enter a search query",
        variant: "destructive",
      })
      return
    }

    setIsSearching(true)
    
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_API_URL}/api/returns/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: returnRequest.searchQuery,
          searchType: returnRequest.searchType
        }),
      });

      if (!response.ok) {
        throw new Error('Search failed')
      }

      const results = await response.json()
      setSearchResults(results)
      
      if (results.length === 0) {
        toast({
          title: "No Results",
          description: "No bills found matching your search criteria",
        })
      }
    } catch (error) {
      console.error("Error searching for bills:", error)
      toast({
        title: "Search Failed",
        description: "Failed to search for bills. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsSearching(false)
    }
  }

  const handleItemSelection = (itemId: string, checked: boolean) => {
    console.log("handleItemSelection called:", { itemId, checked });
    setReturnRequest(prev => ({
      ...prev,
      selectedItems: checked 
        ? [...prev.selectedItems, itemId]
        : prev.selectedItems.filter(id => id !== itemId)
    }))
  }

  const handleSubmitReturn = async () => {
    console.log("handleSubmitReturn called.");
    console.log("Current returnRequest.selectedItems:", returnRequest.selectedItems);
    console.log("Current searchResults:", searchResults);
    console.log("Calculated total before submit:", calculateSelectedTotal());

    if (returnRequest.selectedItems.length === 0) {
      toast({
        title: "No Items Selected",
        description: "Please select at least one item to return",
        variant: "destructive",
      })
      return
    }

    if (!returnRequest.returnReason.trim()) {
      toast({
        title: "Reason Required",
        description: "Please provide a reason for the return",
        variant: "destructive",
      })
      return
    }

    setIsSubmitting(true)

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_API_URL}/api/returns/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selectedItems: returnRequest.selectedItems,
          returnReason: returnRequest.returnReason,
          refundMethod: returnRequest.refundMethod,
          searchResults: searchResults,
          createdBy: user?.name || "Unknown"
        }),
      });

      if (!response.ok) {
        throw new Error('Return submission failed')
      }

      const result = await response.json()
      
      toast({
        title: "Return Submitted",
        description: `Return request submitted successfully. Return ID: ${result.returnId}`,
      })

      // Reset form and close modal
      resetForm()
      onClose()
    } catch (error) {
      console.error("Error submitting return:", error)
      toast({
        title: "Submission Failed",
        description: "Failed to submit return request. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetForm = () => {
    setReturnRequest({
      searchQuery: '',
      searchType: 'customer',
      selectedItems: [],
      returnReason: '',
      refundMethod: 'cash'
    })
    setSearchResults([])
    setShowReturnForm(false)
  }

  const calculateSelectedTotal = () => {
    const total = returnRequest.selectedItems.reduce((total, itemId) => {
      const [billId, itemIdx] = itemId.split('-')
      const bill = searchResults.find(b => b.id === billId)
      const item = bill?.items[parseInt(itemIdx)]
      console.log(`Calculating for itemId: ${itemId}, billId: ${billId}, itemIdx: ${itemIdx}, found bill: ${!!bill}, found item: ${!!item}, item total: ${item?.total || 0}`);
      return total + (item?.total || 0)
    }, 0)
    console.log("calculateSelectedTotal result:", total);
    return total;
  }

  const getSearchPlaceholder = () => {
    switch (returnRequest.searchType) {
      case 'customer': return 'Enter customer name'
      case 'phone': return 'Enter mobile number'
      case 'invoice': return 'Enter invoice number'
      default: return 'Enter search query'
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Process Returns
          </DialogTitle>
          <DialogDescription>
            Search for bills and process return requests
          </DialogDescription>
        </DialogHeader>
        
        {!showReturnForm ? (
          <div className="space-y-6">
            {/* Search Form */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Search Bills</CardTitle>
                <CardDescription>Find bills by customer name, phone number, or invoice number</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-3">
                    <Label>Search By</Label>
                    <RadioGroup
                      value={returnRequest.searchType}
                      onValueChange={(value) => setReturnRequest(prev => ({ ...prev, searchType: value as 'customer' | 'phone' | 'invoice' }))}
                      className="space-y-2"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="customer" id="customer" />
                        <Label htmlFor="customer" className="flex items-center gap-2">
                          <User className="h-4 w-4" />
                          Customer Name
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="phone" id="phone" />
                        <Label htmlFor="phone" className="flex items-center gap-2">
                          <Phone className="h-4 w-4" />
                          Mobile Number
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="invoice" id="invoice" />
                        <Label htmlFor="invoice" className="flex items-center gap-2">
                          <CreditCard className="h-4 w-4" />
                          Invoice Number
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>
                  
                  <div className="space-y-3 md:col-span-2">
                    <Label>Search Query</Label>
                    <div className="flex space-x-2">
                      <Input
                        placeholder={getSearchPlaceholder()}
                        value={returnRequest.searchQuery}
                        onChange={(e) => setReturnRequest(prev => ({ ...prev, searchQuery: e.target.value }))}
                        onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                        className="flex-1"
                      />
                      <Button onClick={handleSearch} disabled={isSearching}>
                        <Search className="h-4 w-4 mr-2" />
                        {isSearching ? 'Searching...' : 'Search'}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Search Results ({searchResults.length} bills found)</CardTitle>
                  <CardDescription>Select items from the bills below to process returns</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {searchResults.map((bill) => (
                      <Card key={bill.id} className="border-2">
                        <CardHeader className="pb-3">
                          <div className="flex justify-between items-start">
                            <div className="space-y-1">
                              <CardTitle className="text-lg">Invoice: {bill.id}</CardTitle>
                              <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                                <span className="flex items-center gap-1">
                                  <User className="h-4 w-4" />
                                  {bill.customerName || 'N/A'}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Phone className="h-4 w-4" />
                                  {bill.customerPhone || 'N/A'}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Clock className="h-4 w-4" />
                                  {new Date(bill.timestamp).toLocaleDateString()}
                                </span>
                                <span className="flex items-center gap-1">
                                  <IndianRupee className="h-4 w-4" />
                                  {bill.total.toFixed(2)}
                                </span>
                              </div>
                              <Badge variant="outline">{bill.paymentMethod}</Badge>
                            </div>
                          </div>
                        </CardHeader>
                        
                        <CardContent>
                          <div className="space-y-3">
                            <h5 className="font-medium text-sm">Items Available for Return:</h5>
                            {bill.items.map((item, idx) => (
                              <div key={`${bill.id}-${idx}`} className="flex items-start space-x-3 p-3 border rounded-lg hover:bg-gray-50">
                                <Checkbox
                                  id={`item-${bill.id}-${idx}`}
                                  checked={returnRequest.selectedItems.includes(`${bill.id}-${idx}`)}
                                  onCheckedChange={(checked) => handleItemSelection(`${bill.id}-${idx}`, checked as boolean)}
                                />
                                <div className="flex-1 space-y-1">
                                  <p className="font-medium">{item.productName}</p>
                                  <div className="flex flex-wrap gap-4 text-xs text-gray-600">
                                    <span>Quantity: {item.quantity}</span>
                                    <span>Unit Price: ₹{item.price.toFixed(2)}</span>
                                    <span className="font-medium">Total: ₹{item.total.toFixed(2)}</span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Selected Items Summary */}
            {returnRequest.selectedItems.length > 0 && (
              <Card className="bg-blue-50 border-blue-200">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg text-blue-800">Selected Items Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <p className="text-sm text-blue-700">
                      {returnRequest.selectedItems.length} item(s) selected for return
                    </p>
                    <p className="text-lg font-semibold text-blue-800">
                      Total Return Amount: ₹{calculateSelectedTotal().toFixed(2)}
                    </p>
                    <Button 
                      onClick={() => setShowReturnForm(true)}
                      className="w-full mt-3"
                      disabled={returnRequest.selectedItems.length === 0}
                    >
                      Proceed to Return Details
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          /* Return Form */
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold">Return Details</h3>
              <Button variant="outline" onClick={() => setShowReturnForm(false)}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Search
              </Button>
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Return Form */}
              <Card>
                <CardHeader>
                  <CardTitle>Return Information</CardTitle>
                  <CardDescription>Provide details for the return request</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="return-reason">Return Reason *</Label>
                    <Textarea
                      id="return-reason"
                      placeholder="Please describe the reason for return..."
                      value={returnRequest.returnReason}
                      onChange={(e) => setReturnRequest(prev => ({ ...prev, returnReason: e.target.value }))}
                      rows={4}
                    />
                  </div>
                  
                  <div className="space-y-3">
                    <Label>Refund Method *</Label>
                    <RadioGroup
                      value={returnRequest.refundMethod}
                      onValueChange={(value) => setReturnRequest(prev => ({ ...prev, refundMethod: value as 'cash' | 'upi' }))}
                      className="space-y-2"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="cash" id="refund-cash" />
                        <Label htmlFor="refund-cash" className="flex items-center gap-2">
                          <CreditCard className="h-4 w-4" />
                          Cash Refund
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="upi" id="refund-upi" />
                        <Label htmlFor="refund-upi" className="flex items-center gap-2">
                          <Phone className="h-4 w-4" />
                          UPI Refund
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>
                </CardContent>
              </Card>

              {/* Selected Items Summary */}
              <Card>
                <CardHeader>
                  <CardTitle>Items for Return</CardTitle>
                  <CardDescription>Review the selected items</CardDescription>
                </CardHeader>
                <CardContent>
                  {returnRequest.selectedItems.length > 0 ? (
                    <div className="space-y-3">
                      {returnRequest.selectedItems.map(itemId => {
                        const [billId, itemIdx] = itemId.split('-')
                        const bill = searchResults.find(b => b.id === billId)
                        const item = bill?.items[parseInt(itemIdx)]
                        return (
                          <div key={itemId} className="p-3 border rounded-lg">
                            <p className="font-medium">{item?.productName}</p>
                            <div className="text-sm text-gray-600 mt-1">
                              <p>Invoice: {billId}</p>
                              <p>Quantity: {item?.quantity} × ₹{item?.price.toFixed(2)}</p>
                              <p className="font-medium">Amount: ₹{item?.total.toFixed(2)}</p>
                            </div>
                          </div>
                        )
                      })}
                      <Separator />
                      <div className="flex justify-between items-center font-semibold text-lg">
                        <span>Total Return Amount:</span>
                        <span>₹{calculateSelectedTotal().toFixed(2)}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-gray-500 text-center py-4">No items selected</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={resetForm}>
            Reset
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {showReturnForm && (
            <Button 
              onClick={handleSubmitReturn}
              disabled={isSubmitting || returnRequest.selectedItems.length === 0}
            >
              {isSubmitting ? 'Submitting...' : 'Submit Return Request'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
