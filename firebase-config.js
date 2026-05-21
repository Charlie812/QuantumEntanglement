// Firebase 設定 — 把下面欄位換成你 Firebase project 的設定值
// 取得步驟：Firebase Console → Project settings → General → Your apps → Web → SDK setup → Config
//
// 安全性說明：這些值會出現在 client，是公開的、無需保密。
// 真正的安全邊界是 Firestore Security Rules（見 README）。
//
// 在沒設定之前，app 會進入 demo 模式（資料只存本機 localStorage、不會跟另外兩人同步）。

export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};
