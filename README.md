# Siri Billing App

This is a billing application designed to manage products, customers, and billing history. It provides a user-friendly interface for creating invoices, tracking sales, and managing inventory.

## Features

- **Product Management:** Add, edit, and delete products with details like name, price, and barcode.
- **Customer Management:** Maintain a database of customers with their contact information.
- **Billing & Invoicing:** Generate invoices, add items to a cart, and process payments.
- **Billing History:** View and manage past invoices and sales records.
- **User Authentication:** Secure login and logout functionality.
- **API Endpoints:** A comprehensive set of API endpoints for managing various aspects of the application.

## Technologies Used

- Next.js
- React
- TypeScript
- Tailwind CSS
- SQLite (for local data storage)
- Tauri (for desktop application bundling)

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- pnpm (or npm/yarn)
- Rust (for Tauri development)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/mahiprime2001/Siri-billing-app.git
   cd Siri-billing-app
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Run the development server:
   ```bash
   pnpm dev
   ```

4. Open your browser to `http://localhost:3000` to see the application.

### Building the Desktop Application (Tauri)

1. Install Tauri prerequisites (if not already installed):
   ```bash
   # For macOS
   brew install rust
   # For other OS, refer to Tauri documentation: https://tauri.app/v1/guides/getting-started/prerequisites/
   ```

2. Build the Tauri application:
   ```bash
   pnpm tauri build
   ```

## API Endpoints

The application exposes several API endpoints for various functionalities:

- `/api/auth/login`
- `/api/auth/logout`
- `/api/auth/forgot-password-proxy`
- `/api/billing/formats`
- `/api/billing/history`
- `/api/billing/items`
- `/api/billing/save`
- `/api/customers`
- `/api/products`
- `/api/products/barcodes`
- `/api/products/upload`
- `/api/settings`
- `/api/stores`
- `/api/user-stores`
- `/api/users`

## Project Structure

```
.
├── app/                  # Next.js pages and API routes
├── components/           # Reusable React components
├── data/                 # Data storage (JSON, MySQL schema)
├── hooks/                # Custom React hooks
├── lib/                  # Utility functions and libraries
├── public/               # Static assets
├── scripts/              # Utility scripts
├── src-tauri/            # Tauri application source code
├── styles/               # Global styles
├── .gitignore            # Git ignore file
├── package.json          # Project dependencies and scripts
├── next.config.mjs       # Next.js configuration
├── tailwind.config.ts    # Tailwind CSS configuration
└── tsconfig.json         # TypeScript configuration
```

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue.

## License

[Specify your license here, e.g., MIT License]
## Release Workflow Test
