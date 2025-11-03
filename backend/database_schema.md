--- Database Schema for u408450631_siri ---

Tables:

Table: BillFormats
  - id (int(11)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - name (varchar(255)) NULLABLE   
  - format (longtext) NULLABLE   

Table: BillItems
  - id (bigint(20)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - billId (varchar(255)) NULLABLE   
  - productId (varchar(255)) NULLABLE   
  - productName (varchar(255)) NULLABLE   
  - quantity (int(11)) NULLABLE   
  - price (decimal(10,2)) NULLABLE   
  - total (decimal(10,2)) NULLABLE   
  - tax (decimal(10,2)) NULLABLE DEFAULT 0.00  
  - gstRate (decimal(10,2)) NULLABLE DEFAULT 0.00  
  - barcodes (text) NULLABLE   
  Foreign Keys:
    - Constraint: BillItems_ibfk_1, Column: billId, References: Bills(id)
    - Constraint: BillItems_ibfk_2, Column: productId, References: Products(id)

Table: Bills
  - id (varchar(255)) NOT NULL  PRIMARY KEY 
  - storeId (varchar(255)) NULLABLE   
  - storeName (varchar(255)) NULLABLE   
  - storeAddress (text) NULLABLE   
  - customerName (varchar(255)) NULLABLE   
  - customerPhone (varchar(255)) NULLABLE   
  - customerEmail (varchar(255)) NULLABLE   
  - customerAddress (text) NULLABLE   
  - customerId (varchar(255)) NULLABLE   
  - subtotal (decimal(10,2)) NULLABLE   
  - taxPercentage (decimal(5,2)) NULLABLE   
  - taxAmount (decimal(10,2)) NULLABLE   
  - discountPercentage (decimal(5,2)) NULLABLE   
  - discountAmount (decimal(10,2)) NULLABLE   
  - total (decimal(10,2)) NULLABLE   
  - paymentMethod (varchar(50)) NULLABLE   
  - timestamp (datetime) NULLABLE   
  - notes (text) NULLABLE   
  - gstin (varchar(255)) NULLABLE   
  - companyName (varchar(255)) NULLABLE   
  - companyAddress (text) NULLABLE   
  - companyPhone (varchar(255)) NULLABLE   
  - companyEmail (varchar(255)) NULLABLE   
  - billFormat (varchar(50)) NULLABLE   
  - createdBy (varchar(255)) NULLABLE   
  Foreign Keys:
    - Constraint: Bills_ibfk_1, Column: storeId, References: Stores(id)
    - Constraint: Bills_ibfk_2, Column: createdBy, References: Users(id)
    - Constraint: Bills_ibfk_3, Column: customerId, References: Customers(id)

Table: Customers
  - id (varchar(255)) NOT NULL  PRIMARY KEY 
  - name (varchar(255)) NULLABLE   
  - phone (varchar(255)) NULLABLE   
  - email (varchar(255)) NULLABLE   
  - address (text) NULLABLE   
  - createdAt (datetime) NULLABLE   
  - updatedAt (datetime) NULLABLE   

Table: Notifications
  - id (int(11)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - type (varchar(50)) NOT NULL   
  - notification (text) NOT NULL   
  - related_id (varchar(255)) NULLABLE   
  - is_read (tinyint(1)) NULLABLE DEFAULT 0  
  - created_at (datetime) NULLABLE DEFAULT current_timestamp()  
  - updated_at (datetime) NULLABLE DEFAULT current_timestamp()  

Table: ProductBarcodes
  - id (int(11)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - productId (varchar(255)) NULLABLE   
  - barcode (varchar(255)) NULLABLE   
  Foreign Keys:
    - Constraint: ProductBarcodes_ibfk_1, Column: productId, References: Products(id)

Table: Products
  - id (varchar(255)) NOT NULL  PRIMARY KEY 
  - name (varchar(255)) NULLABLE   
  - price (decimal(10,2)) NULLABLE   
  - stock (int(11)) NULLABLE   
  - assignedStoreId (varchar(255)) NULLABLE   
  - batchId (varchar(255)) NULLABLE   
  - selling_price (decimal(10,2)) NULLABLE   
  - createdAt (datetime) NULLABLE   
  - updatedAt (datetime) NULLABLE   
  Foreign Keys:
    - Constraint: fk_products_assigned_store, Column: assignedStoreId, References: Stores(id)
    - Constraint: fk_products_batch, Column: batchId, References: batch(id)

Table: Returns
  - s_no (int(11)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - return_id (varchar(36)) NOT NULL   
  - product_name (varchar(255)) NOT NULL   
  - product_id (varchar(255)) NULLABLE   
  - customer_name (varchar(255)) NULLABLE   
  - customer_phone_number (varchar(255)) NULLABLE   
  - message (text) NULLABLE   
  - refund_method (enum('cash','upi')) NULLABLE DEFAULT cash  
  - bill_id (varchar(255)) NULLABLE   
  - item_index (int(11)) NULLABLE   
  - return_amount (decimal(10,2)) NULLABLE   
  - status (enum('pending','approved','rejected','completed')) NULLABLE DEFAULT pending  
  - created_by (varchar(255)) NULLABLE   
  - created_at (datetime) NULLABLE DEFAULT current_timestamp()  
  - updated_at (datetime) NULLABLE DEFAULT current_timestamp()  
  Foreign Keys:
    - Constraint: Returns_ibfk_1, Column: bill_id, References: Bills(id)
    - Constraint: Returns_ibfk_2, Column: product_id, References: Products(id)

Table: Stores
  - id (varchar(255)) NOT NULL  PRIMARY KEY 
  - name (varchar(255)) NULLABLE   
  - address (text) NULLABLE   
  - phone (varchar(255)) NULLABLE   
  - status (varchar(50)) NULLABLE   
  - createdAt (datetime) NULLABLE   
  - updatedAt (datetime) NULLABLE   

Table: SystemSettings
  - id (int(11)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - gstin (varchar(255)) NULLABLE   
  - taxPercentage (decimal(5,2)) NULLABLE   
  - companyName (varchar(255)) NULLABLE   
  - companyAddress (text) NULLABLE   
  - companyPhone (varchar(255)) NULLABLE   
  - companyEmail (varchar(255)) NULLABLE   

Table: UserStores
  - userId (varchar(255)) NOT NULL  PRIMARY KEY 
  - storeId (varchar(255)) NOT NULL  PRIMARY KEY 
  Foreign Keys:
    - Constraint: UserStores_ibfk_1, Column: userId, References: Users(id)
    - Constraint: UserStores_ibfk_2, Column: storeId, References: Stores(id)

Table: Users
  - id (varchar(255)) NOT NULL  PRIMARY KEY 
  - name (varchar(255)) NULLABLE   
  - email (varchar(255)) NULLABLE   
  - password (varchar(255)) NULLABLE   
  - role (varchar(50)) NULLABLE   
  - status (varchar(50)) NULLABLE   
  - sessionDuration (int(11)) NULLABLE   
  - createdAt (datetime) NULLABLE   
  - updatedAt (datetime) NULLABLE   
  - lastLogin (datetime) NULLABLE   
  - lastLogout (datetime) NULLABLE   
  - totalSessionDuration (int(11)) NULLABLE DEFAULT 0  

Table: app_config
  - id (int(11)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - config_key (varchar(100)) NOT NULL   
  - config_value (text) NOT NULL   
  - created_at (datetime) NULLABLE DEFAULT current_timestamp()  
  - updated_at (datetime) NULLABLE DEFAULT current_timestamp()  

Table: batch
  - id (varchar(255)) NOT NULL  PRIMARY KEY 
  - batchnumber (varchar(255)) NOT NULL   
  - place (text) NULLABLE   
  - createdat (timestamp) NULLABLE DEFAULT current_timestamp()  
  - updatedat (timestamp) NULLABLE DEFAULT current_timestamp()  

Table: batch_new
  - id (varchar(255)) NOT NULL  PRIMARY KEY 
  - batchnumber (varchar(255)) NOT NULL   
  - place (text) NULLABLE   
  - createdat (timestamp) NULLABLE DEFAULT current_timestamp()  
  - updatedat (timestamp) NULLABLE DEFAULT current_timestamp()  

Table: password_change_log
  - id (bigint(20)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - user_id (varchar(255)) NOT NULL   
  - changed_at (datetime) NULLABLE DEFAULT current_timestamp()  
  - ip_address (varchar(45)) NULLABLE   
  - user_agent (text) NULLABLE   
  - change_type (enum('reset','change','admin')) NULLABLE DEFAULT reset  
  Foreign Keys:
    - Constraint: password_change_log_ibfk_1, Column: user_id, References: Users(id)

Table: password_reset_tokens
  - id (bigint(20)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - user_id (varchar(255)) NOT NULL   
  - token_hash (varchar(64)) NOT NULL   
  - expires_at (datetime) NOT NULL   
  - used_at (datetime) NULLABLE   
  - created_at (datetime) NULLABLE DEFAULT current_timestamp()  
  Foreign Keys:
    - Constraint: password_reset_tokens_ibfk_1, Column: user_id, References: Users(id)

Table: sync_table
  - id (int(11)) NOT NULL  PRIMARY KEY AUTO_INCREMENT
  - table_name (varchar(100)) NOT NULL   
  - record_id (varchar(255)) NOT NULL   
  - operation_type (enum('CREATE','UPDATE','DELETE')) NOT NULL   
  - change_data (longtext) NOT NULL   
  - source (enum('local','remote')) NULLABLE DEFAULT local  
  - status (enum('pending','synced','failed')) NULLABLE DEFAULT pending  
  - sync_attempts (int(11)) NULLABLE DEFAULT 0  
  - created_at (datetime) NULLABLE DEFAULT current_timestamp()  
  - synced_at (datetime) NULLABLE   

Table: sync_table_backup
  - id (int(11)) NOT NULL DEFAULT 0  
  - sync_time (datetime) NULLABLE   
  - change_type (varchar(50)) NULLABLE   
  - change_data (longtext) NULLABLE   
  - timestamp (datetime) NULLABLE DEFAULT current_timestamp()
