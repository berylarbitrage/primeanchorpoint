# Prime Anchorpoint

Staffing website with trilingual support (EN/中文/ES).

## Local Development
```
npm install
node server.js
```
Open http://localhost:3000

Admin panel: http://localhost:3000/admin
Default password: `prime2026`

## Deploy to Railway
1. Push to GitHub
2. Connect repo to Railway
3. Add a Volume (mount path: `/data`)
4. Set env var: `ADMIN_PASS=your_secure_password`
5. Deploy

## Custom Domain
In Railway → Settings → Custom Domain → add `primeanchorpoint.com`
Then update DNS A record to Railway's IP.
