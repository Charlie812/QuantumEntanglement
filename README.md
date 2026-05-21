# 量子糾纏 ✨

Charlie / 偉賢 / Eric 三人之間的 IOU 記帳 PWA。

- 三行輸入：選自己 → 選金額 → 選對方 → `[新增記錄]`
- 結帳按鈕用**最小現金流演算法**算出最少轉帳次數
- 三人 real-time 同步（Firebase Firestore）
- 可加到 iOS / Android 桌面當 app 用

部署網址：<https://charlie812.github.io/QuantumEntanglement/>

---

## 第一次設定（給 owner 看的）

### 1. 開 Firebase project

1. 去 [Firebase Console](https://console.firebase.google.com/) → **Add project** → 名稱 `quantum-entanglement`（隨意）
2. 不需要 Google Analytics
3. 進專案後 → **Build** → **Firestore Database** → **Create database**
   - Mode：**Production mode**
   - Location：`asia-east1`（台灣）或 `asia-northeast1`（東京）
4. Firestore → **Rules** tab，貼上：

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /entries/{doc}     { allow read, write: if true; }
       match /settlements/{doc} { allow read, write: if true; }
     }
   }
   ```

   → **Publish**

5. **Project settings**（齒輪 icon）→ 拉到 **Your apps** → 點 `</>` icon (Web)
   - App nickname：`quantum-entanglement-web`
   - **不要勾** Firebase Hosting
   - **Register app** → 會看到 `firebaseConfig` 物件
6. **Authentication 不用開**（我們是純信任模式）
7. **Authorized domains**（Authentication → Settings）→ 加 `charlie812.github.io`

### 2. 填入 config

打開 `firebase-config.js`，把 `REPLACE_ME` 換成 Firebase 給你的值：

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc...",
};
```

> 這些值是公開的、不用保密 —— 真正的安全邊界是 Firestore Rules。

### 3. Push 到 GitHub Pages

```bash
cd QuantumEntanglement
git init && git branch -M main
git add .
git commit -m "init"
git remote add origin git@github.com:Charlie812/QuantumEntanglement.git
git push -u origin main
```

到 GitHub repo → **Settings** → **Pages** → **Source: Deploy from branch** → `main` / `(root)` → **Save**。

約 1 分鐘後上線：<https://charlie812.github.io/QuantumEntanglement/>

---

## 給三個人怎麼用

### iOS Safari

1. 打開上面那條網址
2. 點下方分享按鈕 → **加到主畫面**
3. 桌面就會多一個「量子糾纏」icon，點開全螢幕

### Android Chrome

1. 打開網址
2. 右上選單 → **加到主畫面** / **安裝應用程式**
3. 桌面 icon 點開

### 使用流程

1. **第一次開**先選自己是誰（會記住，下次自動帶）
2. 第二行用數字鍵盤輸入金額（不用打小數，台幣整數就好）
3. 第三行選對方
4. (可選) 寫備註
5. 按「新增記錄」

#### 結帳

底部綠色「💰 結帳」按下去 → 跳 modal：

- 顯示每個人**淨額**（+ 代表別人欠你、− 代表你欠別人）
- 顯示**最少轉帳建議**（例：「Charlie 付偉賢 $70；Charlie 付 Eric $20」）
- 確認後**封存**所有未結算的記錄，可在歷史頁查看

#### 刪除誤輸入

長按條目（約 0.5 秒）→ 跳出刪除確認。

#### 看歷史

右上 `≡` icon 切換到結帳歷史頁。

---

## 本機開發 / debug

```bash
# 在 repo 目錄底下開個 dev server
python3 -m http.server 8080
# 然後 http://localhost:8080
```

`firebase-config.js` 還沒設好之前，app 會進**Demo 模式**（資料只存本機 localStorage、不會同步）。設好之後重新整理就會接 Firestore。

Console 有暴露 `window.__qe`（state / computeSettlement / backend）方便 debug。

---

## 結算演算法

**Pair-net**：對每組兩個人單獨算淨額、照原本的記帳方向轉帳。

例：Charlie 欠偉賢 $100、偉賢欠 Charlie $30、Charlie 欠 Eric $50
- Charlie ↔ 偉賢：Charlie 付偉賢 $70（100 - 30）
- Charlie ↔ Eric：Charlie 付 Eric $50
- 偉賢 ↔ Eric：不用轉

每組轉一筆、最多 3 筆。比起「最小轉帳次數」可能多一兩筆，但「誰欠誰多少」一眼可見，不會把錢從 A 繞到 B 再繞到 C。

---

## 檔案結構

```
QuantumEntanglement/
├── index.html              # 主結構
├── app.css                 # 樣式（dark theme）
├── app.js                  # 邏輯 + Firestore 整合 + 結算演算法
├── firebase-config.js      # Firebase web config（要填）
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker（cache app shell）
├── icons/
│   ├── icon-192.png        # PWA icon
│   ├── icon-512.png
│   ├── apple-touch-icon.png
│   └── gen_icons.py        # 重新產生 icons 用
└── README.md
```

---

## 已知限制

- **沒有真正的權限控管**：Firestore Rules 全開、誰開 URL 都能讀寫。靠「URL 不公開 + 三人自律」。要加鎖請改用 Firebase anonymous auth + 把 uid 寫進 entry，rule 檢查 `from == uid`。
- **只支援三人 + 整數 TWD**。要改人名/幣別請改 `app.js` 的 `PEOPLE` 常數 + UI 的三個 button。
- **無編輯功能**，只能刪除。寫錯了刪掉重新輸入。
