# AdminLank Dashboard

Panel de administración para el sistema Lank.

## Stack Tecnológico
- **Frontend**: React + Vite
- **Backend**: Firebase (Firestore, Cloud Functions, Hosting, Auth)
- **Hosting**: configurar en `.env.local`

## Desarrollo local
```bash
cd dashboard
npm install
npm run dev
```

## Despliegue
```bash
npx vite build
npx firebase deploy --only hosting
```
