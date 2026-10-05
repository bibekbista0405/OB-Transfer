# OB Transfer

OB Transfer is a self-hosted file transfer and media streaming application built with authenticated access, protected real-time events, robust upload validation, storage quota management, and browser security hardening.

## Features & Highlights

- **Authenticated Access:** Session-based authentication enforced across API and Socket.IO connections.
- **Upload Hardening:** Opaque UUID file storage to prevent path traversal and arbitrary exposure.
- **Quota & Limit Controls:** Built-in safeguards for file size, storage capacity, record counts, and concurrency limits.
- **Safe Media Delivery:** MIME-type validation that forces untrusted file types to download safely rather than rendering inline.

## Prerequisites

- **Node.js**: v20.0.0 or higher

## Local Development Setup

1. **Install dependencies:**
   ```bash
   npm install
