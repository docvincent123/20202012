# RehaFlow Command Center

Windows desktop Command Center for a modern rehabilitation/medical clinic.

## Product direction

- Premium dark medical command-center UI
- React frontend in a native C# WPF/WebView2 shell
- Modular desktop-first information architecture
- API-first contracts ready for a future NestJS + PostgreSQL backend
- Future mobile clients for doctors and nurses consume the same API/domain model

## Desktop modules

- Dashboard / clinic monitoring
- Reception & admissions
- Patient registry and patient profiles
- Beds / rooms / departments
- Tasks & operations
- Documents / archive / PDF export
- Scheduling
- Staff and shifts
- Billing / administrative records
- Analytics & reports
- Notifications center
- Administration / RBAC / dictionaries / audit logs

## UX principles

The desktop application is an operational center rather than a mobile workflow. It prioritizes global visibility, fast search, dense but readable information, keyboard/mouse efficiency, auditability, and clear escalation of critical items.

Visual language: near-black graphite surfaces, restrained teal/cyan accents, high contrast typography, subtle ambient animation, soft glass effects where useful, polished transitions, skeleton loading, empty states, confirmation dialogs, and clear focus states.

## Long-term backend

The desktop app should not depend on Netlify serverless functions as the system of record. The planned backend is NestJS + PostgreSQL + REST + Socket.IO/WebSockets. Until that backend is introduced, keep the UI on a replaceable mock/API adapter.
