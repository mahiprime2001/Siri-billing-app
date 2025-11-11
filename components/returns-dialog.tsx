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
import { apiClient } from "@/lib/api-client"

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
  selectedItems: { id: string; quantity: number }[] // Modified to include quantity
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
      const response = await apiClient('/api/returns/search', {
        method: 'POST',
        body: JSON.stringify({
          query: returnRequest.searchQuery,
          searchType: returnRequest.searchType
        }),
      });

      let results: Bill[] = []
      try {
        results = await response.json()
        console.log("API Search Results:", results)
      } catch (jsonError) {
        console.error("Error parsing API search results JSON:", jsonError)
        toast({
          title: "Data Error",
          description: "Failed to parse search results from the server.",
          variant: "destructive",
        })
      }

      setSearchResults(results)
      if (results.length === 0) {
        toast({
          title: "No Results",
          description: "No bills found matching your search criteria",
        })
      } else {
        toast({
          title: "Search Complete",
          description: `${results.length} bills found.`,
        })
      }
    } catch (error) {
      console.error("Error searching for bills:", error)
      toast({
        title: "Search Failed",
        description: (error as Error).message || "Failed to search for bills. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsSearching(false)
    }
  }

  const handleItemSelection = (itemId: string, checked: boolean, maxQuantity: number) => {
    console.log("handleItemSelection called:", { itemId, checked });
    setReturnRequest(prev => {
      if (checked) {
        return {
          ...prev,
          selectedItems: [...prev.selectedItems, { id: itemId, quantity: 1 }]
        }
      } else {
        return {
          ...prev,
          selectedItems: prev.selectedItems.filter(item => item.id !== itemId)
        }
      }
    })
  }

  const handleQuantityChange = (itemId: string, newQuantity: number, maxQuantity: number) => {
    const clampedQuantity = Math.max(1, Math.min(newQuantity, maxQuantity))
    setReturnRequest(prev => ({
      ...prev,
      selectedItems: prev.selectedItems.map(item =>
        item.id === itemId ? { ...item, quantity: clampedQuantity } : item
      )
    }))
  }

  const isItemSelected = (itemId: string) => {
    return returnRequest.selectedItems.some(item => item.id === itemId)
  }

  const getItemQuantity = (itemId: string) => {
    const item = returnRequest.selectedItems.find(item => item.id === itemId)
    return item?.quantity || 1
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
      const response = await apiClient('/api/returns/submit', {
        method: 'POST',
        body: JSON.stringify({
          selectedItems: returnRequest.selectedItems,
          returnReason: returnRequest.returnReason,
          refundMethod: returnRequest.refundMethod,
          searchResults: searchResults,
          createdBy: user?.name || "Unknown"
        }),
      });

      const result = await response.json()
      toast({
        title: "Return Submitted",
        description: `Return request submitted successfully. Return ID: ${result.returnId}`,
      })

      resetForm()
      onClose()
    } catch (error) {
      console.error("Error submitting return:", error)
      toast({
        title: "Submission Failed",
        description: (error as Error).message || "Failed to submit return request. Please try again.",
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
    const total = returnRequest.selectedItems.reduce((total, selectedItem) => {
      const lastHyphenIndex = selectedItem.id.lastIndexOf('-');
      const billId = selectedItem.id.substring(0, lastHyphenIndex);
      const itemIdx = selectedItem.id.substring(lastHyphenIndex + 1);
      const bill = searchResults.find(b => b.id === billId)
      const item = bill?.items[parseInt(itemIdx)]
      const itemTotal = (item?.price || 0) * selectedItem.quantity
      console.log(`Calculating for itemId: ${selectedItem.id}, quantity: ${selectedItem.quantity}, billId: ${billId}, itemIdx: ${itemIdx}, found bill: ${!!bill}, found item: ${!!item}, item total: ${itemTotal}`);
      return total + itemTotal
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
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
          <>
            {/* Search Form */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Search Bills</CardTitle>
                <CardDescription>Find bills by customer name, phone number, or invoice number</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Search By</Label>
                  <RadioGroup
                    value={returnRequest.searchType}
                    onValueChange={(value) => {
                      console.log("RadioGroup onValueChange:", value);
                      setReturnRequest(prev => ({ ...prev, searchType: value as 'customer' | 'phone' | 'invoice' }));
                    }}
                    className="space-y-2"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="customer" id="customer" />
                      <Label htmlFor="customer" className="font-normal cursor-pointer">
                        <User className="h-4 w-4 inline mr-1" />
                        Customer Name
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="phone" id="phone" />
                      <Label htmlFor="phone" className="font-normal cursor-pointer">
                        <Phone className="h-4 w-4 inline mr-1" />
                        Mobile Number
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="invoice" id="invoice" />
                      <Label htmlFor="invoice" className="font-normal cursor-pointer">
                        <CreditCard className="h-4 w-4 inline mr-1" />
                        Invoice Number
                      </Label>
                    </div>
                  </RadioGroup>
                </div>

                <div className="flex gap-2">
                  <div className="flex-1">
                    <Label>Search Query</Label>
                    <Input
                      placeholder={getSearchPlaceholder()}
                      value={returnRequest.searchQuery}
                      onChange={(e) => setReturnRequest(prev => ({ ...prev, searchQuery: e.target.value }))}
                      onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                      className="flex-1"
                    />
                  </div>
                  <Button onClick={handleSearch} disabled={isSearching} className="mt-6">
                    <Search className="h-4 w-4 mr-2" />
                    {isSearching ? 'Searching...' : 'Search'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Search Results ({searchResults.length} bills found)</CardTitle>
                  <CardDescription>Select items from the bills below to process returns</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {searchResults.map((bill) => (
                    <Card key={bill.id} className="border">
                      <CardHeader className="pb-3">
                        <div className="flex justify-between items-start">
                          <div>
                            <CardTitle className="text-md">Invoice: {bill.id}</CardTitle>
                            <div className="flex gap-4 mt-2 text-sm text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <User className="h-3 w-3" />
                                {bill.customerName || 'N/A'}
                              </span>
                              <span className="flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                {bill.customerPhone || 'N/A'}
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {new Date(bill.timestamp).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                          <div className="text-right">
                            <Badge variant="secondary" className="mb-1">
                              <IndianRupee className="h-3 w-3 mr-1" />
                              {bill.total.toFixed(2)}
                            </Badge>
                            <div className="text-xs text-muted-foreground">{bill.paymentMethod}</div>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <Label className="text-sm font-semibold">Items Available for Return:</Label>
                        <div className="space-y-2 mt-2">
                          {bill.items.map((item, idx) => {
                            const itemId = `${bill.id}-${idx}`
                            const isSelected = isItemSelected(itemId)
                            const selectedQuantity = getItemQuantity(itemId)
                            
                            return (
                              <div key={idx} className="flex items-center gap-3 p-3 border rounded-lg hover:bg-accent/50">
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={(checked) => handleItemSelection(itemId, checked as boolean, item.quantity)}
                                />
                                <div className="flex-1">
                                  <div className="font-medium">{item.productName}</div>
                                  <div className="text-sm text-muted-foreground space-x-3">
                                    <span>Available: {item.quantity}</span>
                                    <span>Unit Price: ₹{item.price.toFixed(2)}</span>
                                    <span>Total: ₹{item.total.toFixed(2)}</span>
                                  </div>
                                </div>
                                {isSelected && (
                                  <div className="flex items-center gap-2">
                                    <Label htmlFor={`qty-${itemId}`} className="text-sm whitespace-nowrap">Return Qty:</Label>
                                    <Input
                                      id={`qty-${itemId}`}
                                      type="number"
                                      min={1}
                                      max={item.quantity}
                                      value={selectedQuantity}
                                      onChange={(e) => handleQuantityChange(itemId, parseInt(e.target.value) || 1, item.quantity)}
                                      className="w-20"
                                    />
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Selected Items Summary */}
            {returnRequest.selectedItems.length > 0 && (
              <Card className="border-primary">
                <CardHeader>
                  <CardTitle className="text-lg">Selected Items Summary</CardTitle>
                  <CardDescription>
                    {returnRequest.selectedItems.length} item(s) selected for return
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex justify-between items-center">
                    <span className="text-lg font-semibold">Total Return Amount:</span>
                    <span className="text-2xl font-bold text-primary">₹{calculateSelectedTotal().toFixed(2)}</span>
                  </div>
                  <Button
                    onClick={() => setShowReturnForm(true)}
                    className="w-full mt-3"
                    disabled={returnRequest.selectedItems.length === 0}
                  >
                    Proceed to Return Details
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          /* Return Form */
          <div className="space-y-4">
            <Button variant="outline" onClick={() => setShowReturnForm(false)}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Search
            </Button>

            {/* Return Form */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Return Information</CardTitle>
                <CardDescription>Provide details for the return request</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="returnReason">Return Reason *</Label>
                  <Textarea
                    id="returnReason"
                    placeholder="Explain why these items are being returned..."
                    value={returnRequest.returnReason}
                    onChange={(e) => setReturnRequest(prev => ({ ...prev, returnReason: e.target.value }))}
                    rows={4}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Refund Method *</Label>
                  <RadioGroup
                    value={returnRequest.refundMethod}
                    onValueChange={(value) => setReturnRequest(prev => ({ ...prev, refundMethod: value as 'cash' | 'upi' }))}
                    className="space-y-2"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="cash" id="cash" />
                      <Label htmlFor="cash" className="font-normal cursor-pointer">Cash Refund</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="upi" id="upi" />
                      <Label htmlFor="upi" className="font-normal cursor-pointer">UPI Refund</Label>
                    </div>
                  </RadioGroup>
                </div>
              </CardContent>
            </Card>

            {/* Selected Items Summary */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Items for Return</CardTitle>
                <CardDescription>Review the selected items</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {returnRequest.selectedItems.length > 0 ? (
                  <>
                    {returnRequest.selectedItems.map(selectedItem => {
                      const lastHyphenIndex = selectedItem.id.lastIndexOf('-');
                      const billId = selectedItem.id.substring(0, lastHyphenIndex);
                      const itemIdx = selectedItem.id.substring(lastHyphenIndex + 1);
                      const bill = searchResults.find(b => b.id === billId)
                      const item = bill?.items[parseInt(itemIdx)]

                      return (
                        <div key={selectedItem.id} className="flex justify-between items-center p-3 border rounded-lg">
                          <div>
                            <div className="font-medium">{item?.productName}</div>
                            <div className="text-sm text-muted-foreground">Invoice: {billId}</div>
                            <div className="text-sm text-muted-foreground">
                              Quantity: {selectedItem.quantity} × ₹{item?.price.toFixed(2)}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-semibold">Amount: ₹{((item?.price || 0) * selectedItem.quantity).toFixed(2)}</div>
                          </div>
                        </div>
                      )
                    })}
                    <Separator />
                    <div className="flex justify-between items-center text-lg font-semibold pt-2">
                      <span>Total Return Amount:</span>
                      <span className="text-primary">₹{calculateSelectedTotal().toFixed(2)}</span>
                    </div>
                  </>
                ) : (
                  <p className="text-center text-muted-foreground py-4">No items selected</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={resetForm}>
            Reset
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {showReturnForm && (
            <Button onClick={handleSubmitReturn} disabled={isSubmitting}>
              {isSubmitting ? 'Submitting...' : 'Submit Return Request'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
