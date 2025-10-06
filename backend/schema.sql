-- MySQL Schema for Hybrid Billing + Admin System

-- Table: Users
CREATE TABLE IF NOT EXISTS `Users` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL UNIQUE,
    `password` VARCHAR(255) NOT NULL,
    `role` VARCHAR(50) NOT NULL, -- e.g., 'admin', 'billing_user', 'temporary_user'
    `status` VARCHAR(50) DEFAULT 'active',
    `lastLogin` DATETIME NULL,
    `lastLogout` DATETIME NULL,
    `totalSessionDuration` INT DEFAULT 0, -- in seconds
    `storeId` VARCHAR(255) NULL, -- For direct assignment to a single store
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Table: Stores
CREATE TABLE IF NOT EXISTS `Stores` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `address` TEXT,
    `phone` VARCHAR(50),
    `email` VARCHAR(255),
    `gstin` VARCHAR(20),
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Table: Products
CREATE TABLE IF NOT EXISTS `Products` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT,
    `price` DECIMAL(10, 2) NOT NULL,
    `cost` DECIMAL(10, 2) DEFAULT 0.00,
    `stock` INT DEFAULT 0,
    `tax` DECIMAL(5, 2) DEFAULT 0.00, -- Tax percentage
    `category` VARCHAR(255),
    `supplier` VARCHAR(255),
    `barcodes` TEXT, -- Comma-separated barcodes
    `imageUrl` VARCHAR(255),
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Table: Customers
CREATE TABLE IF NOT EXISTS `Customers` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(50) UNIQUE,
    `email` VARCHAR(255),
    `address` TEXT,
    `loyaltyPoints` INT DEFAULT 0,
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Table: Bills
CREATE TABLE IF NOT EXISTS `Bills` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `storeId` VARCHAR(255) NOT NULL,
    `customerId` VARCHAR(255) NULL,
    `subtotal` DECIMAL(10, 2) NOT NULL,
    `taxPercentage` DECIMAL(5, 2) NOT NULL,
    `taxAmount` DECIMAL(10, 2) NOT NULL,
    `discountPercentage` DECIMAL(5, 2) DEFAULT 0.00,
    `discountAmount` DECIMAL(10, 2) DEFAULT 0.00,
    `total` DECIMAL(10, 2) NOT NULL,
    `paymentMethod` VARCHAR(50) NOT NULL,
    `timestamp` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `notes` TEXT,
    `billFormat` VARCHAR(50) DEFAULT 'Thermal 80mm',
    `createdBy` VARCHAR(255) NULL, -- User who created the bill
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (`storeId`) REFERENCES `Stores`(`id`) ON DELETE CASCADE,
    FOREIGN KEY (`customerId`) REFERENCES `Customers`(`id`) ON DELETE SET NULL,
    FOREIGN KEY (`createdBy`) REFERENCES `Users`(`id`) ON DELETE SET NULL
);

-- Table: BillItems
CREATE TABLE IF NOT EXISTS `BillItems` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `billId` VARCHAR(255) NOT NULL,
    `productId` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `quantity` INT NOT NULL,
    `price` DECIMAL(10, 2) NOT NULL,
    `total` DECIMAL(10, 2) NOT NULL,
    `tax` DECIMAL(5, 2) DEFAULT 0.00,
    `gstRate` DECIMAL(5, 2) DEFAULT 0.00,
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (`billId`) REFERENCES `Bills`(`id`) ON DELETE CASCADE,
    FOREIGN KEY (`productId`) REFERENCES `Products`(`id`) ON DELETE CASCADE
);

-- Table: SystemSettings
CREATE TABLE IF NOT EXISTS `SystemSettings` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY DEFAULT 'app-settings', -- Fixed ID for single settings entry
    `gstin` VARCHAR(20),
    `taxPercentage` DECIMAL(5, 2) DEFAULT 0.00,
    `companyName` VARCHAR(255),
    `companyAddress` TEXT,
    `companyPhone` VARCHAR(50),
    `companyEmail` VARCHAR(255),
    `currencySymbol` VARCHAR(10) DEFAULT '₹',
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Table: BillFormats
CREATE TABLE IF NOT EXISTS `BillFormats` (
    `id` VARCHAR(255) NOT NULL PRIMARY KEY,
    `name` VARCHAR(255) NOT NULL,
    `formatJson` JSON, -- Store the JSON structure of the bill format
    `isDefault` BOOLEAN DEFAULT FALSE,
    `createdAt` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Table: SyncLogs (for tracking sync operations)
CREATE TABLE IF NOT EXISTS `SyncLogs` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `timestamp` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `operation` VARCHAR(50) NOT NULL, -- e.g., 'push', 'pull', 'full_sync'
    `status` VARCHAR(50) NOT NULL, -- e.g., 'SUCCESS', 'FAILED'
    `message` TEXT,
    `details` JSON -- Store additional JSON details about the sync operation
);

-- Optional: Add indexes for performance
CREATE INDEX idx_bills_timestamp ON `Bills`(`timestamp`);
CREATE INDEX idx_bills_storeId ON `Bills`(`storeId`);
CREATE INDEX idx_products_name ON `Products`(`name`);
CREATE INDEX idx_products_barcodes ON `Products`(`barcodes`(255)); -- Index on prefix for TEXT column
CREATE INDEX idx_customers_phone ON `Customers`(`phone`);
CREATE INDEX idx_users_email ON `Users`(`email`);
CREATE INDEX idx_users_storeId ON `Users`(`storeId`);
CREATE INDEX idx_billitems_billId ON `BillItems`(`billId`);
CREATE INDEX idx_billitems_productId ON `BillItems`(`productId`);
