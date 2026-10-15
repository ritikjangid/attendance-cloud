# 📱 100% Cloud Mobile Attendance System (No PC Required)

Zero-hardware cloud attendance setup for **Secureye S-FB3K / Realand M61** biometric terminals.  
The machine connects directly to the cloud via office Wi-Fi, triggers instant SMS alerts via TextBee, and streams real-time attendance to your mobile phone from anywhere in the world.

---

## 🚀 Quick Step-by-Step Setup Guide

### Step 1: Create a Free Account on Render (1 Minute)
1. Go to [render.com](https://render.com).
2. Click **Get Started for Free** (sign up with your Google or GitHub account).

---

### Step 2: Push the `mobile` Folder to GitHub
If you don't already have a GitHub repo for this folder:
1. Open PowerShell / Command Prompt inside the `mobile` folder:
   ```powershell
   cd "d:\DATA D\Desktop\machining point\website\ATTENDANCE\mobile"
   git init
   git add .
   git commit -m "Initial cloud attendance deploy"
   ```
2. Create a new repository on [github.com](https://github.com/new) named `attendance-cloud`.
3. Push your code:
   ```powershell
   git remote add origin https://github.com/<your-username>/attendance-cloud.git
   git branch -M main
   git push -u origin main
   ```

---

### Step 3: Deploy on Render (Free Forever)
1. On your Render dashboard, click **New +** (top right) $\to$ **Web Service**.
2. Select **Build and deploy from a Git repository** $\to$ choose your `attendance-cloud` repository.
3. Render will auto-fill:
   - **Name**: `machining-point` (or any name you pick)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free**
4. Click **Deploy Web Service** at the bottom!
5. In about 60 seconds, Render will show **Live** and give you your public URL:
   ```text
   https://machining-point.onrender.com
   ```

---

### Step 4: Configure Your S-FB3K Biometric Machine
On the physical machine keypad:
1. Press **Menu** (or **M/OK**) $\to$ Enter Admin PIN/Fingerprint.
2. Go to **Comm** (Communication) $\to$ **Cloud Server** (or **Server-Client Mode**).
3. Set **Server Client Mode**: `FkWeb` (or `WebSocket`).
4. Set **Web URL**:
   - If using `FkWeb`: `http://machining-point.onrender.com/ebkn`
   - If using `WebSocket`: `ws://machining-point.onrender.com/`
5. Press **Save** / **OK** and exit the menu.

---

### Step 5: Open on Your Mobile Phone
1. Open Chrome or Safari on your phone.
2. Visit your link: `https://machining-point.onrender.com`
3. Tap **Add to Home screen** in your browser menu:
   - On iPhone: Tap the Share button (square with arrow) $\to$ **Add to Home Screen**.
   - On Android: Tap 3 dots (top right) $\to$ **Install App** or **Add to Home screen**.
4. The attendance app will now open full screen like a native mobile app!

---

## ⚡ How Render Free Tier Stays Awake 24/7 Automatically
Usually, Render's free tier goes to sleep after 15 minutes of inactivity.  
**With your S-FB3K machine, this will NEVER happen!**  
The S-FB3K machine automatically sends an outbound heartbeat poll (`receive_cmd`) every **3 seconds**. This continuous pulse keeps your Render cloud server active 24 hours a day, 7 days a week, completely free!
