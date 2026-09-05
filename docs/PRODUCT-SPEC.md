# RehaFlow Command Center — Product Specification

## 1. Command Center Dashboard

Purpose: give reception, administration, chief physician and senior nurse a live overview of the clinic.

Widgets:
- Current inpatient census
- Bed occupancy and availability by department
- Today's admissions / discharges / transfers
- Critical task radar with configurable overdue thresholds
- Staff currently online / on shift
- Unread alerts and escalation queue
- Task throughput by status
- Recent activity/audit feed
- Quick actions: admit patient, find patient, assign bed, create task, print/export report

## 2. Reception & Admissions

- Patient creation with demographics, contacts and emergency contact
- Duplicate detection before creation
- Consent checklist and document generation
- Admission workflow
- Department/ward selection
- Attending physician assignment
- Source/referral fields
- Insurance/payer/admin fields with role restrictions
- Fast search by name, phone, patient number
- Admission history

## 3. Patient Registry & Profile

- Search/filter/sort patient registry
- Patient status: active, discharged, archived, transferred
- Patient profile header with room/bed and responsible clinician
- Clinical timeline
- Diagnoses and problems
- Allergies and alerts
- Medication/treatment summary
- Tasks
- Appointments
- Documents and generated reports
- Previous admissions
- Audit trail of relevant changes

## 4. Bed & Room Management

- Department → ward → room → bed hierarchy
- Visual bed map
- States: available, occupied, dirty/needs cleaning, maintenance, reserved
- Patient assignment
- Transfer workflow with confirmation
- Transfer history
- Cleaning workflow after discharge/transfer
- Occupancy analytics

## 5. Tasks & Operations

The desktop client supervises operational tasks; doctors and nurses will later execute them from mobile clients.

- Task creation and templates
- Patient-linked and non-patient tasks
- Assignee and team
- Priority: routine, important, urgent, critical
- Scheduled due time
- Recurrence
- Status: queued, accepted, in progress, completed, overdue, cancelled
- Escalation rules
- Completion notes / attachments
- Audit trail
- Real-time event contract for future Socket.IO delivery

## 6. Documents & Archive

- Document templates
- Discharge summary / epicrisis generation
- Consent and administrative documents
- PDF generation
- Print preview and printing
- Archive search
- Document version history
- Patient document timeline
- Export packages for authorized users

## 7. Scheduling

- Appointment calendar
- Doctor schedules
- Room/resource calendar
- Admission/discharge calendar
- Staff shifts
- Conflict detection
- Day/week/month views

## 8. Staff & Presence

- Staff directory
- Roles: admin, chief physician, physician, senior nurse, nurse, reception, records/archivist, billing
- Department assignment
- Shift planning
- Account lifecycle
- Online/offline/presence status
- Last activity

## 9. Billing & Administrative Records

Keep financial data separated from clinical permissions.

- Services catalog
- Charges/invoices
- Payer data
- Payment state
- Administrative exports
- Role-based access

## 10. Analytics & Reporting

- Census trends
- Occupancy trends
- Admissions/discharges
- Transfers
- Task completion and overdue rate
- Staff workload
- Department comparisons
- Date-range filters
- CSV/PDF export

## 11. Notifications & Escalation

- Notification center
- Critical incident banner
- Unread queue
- Desktop notifications
- Escalation to senior nurse / administrator
- Notification preferences
- Read/acknowledge state

## 12. Administration

- Users and roles
- RBAC permissions
- Departments
- Wards / rooms / beds
- Task types and priorities
- Clinical/admin dictionaries
- Report templates
- Notification rules
- Audit log
- System settings

## 13. Desktop architecture

Frontend:
- React + TypeScript
- Modular routes/features
- Query/cache layer separated from UI
- Central domain models
- API adapter interface

Desktop shell:
- C# .NET 8 WPF
- WebView2
- Native bridge for OS capabilities and future high-value operations

Backend target:
- NestJS
- PostgreSQL
- REST API
- Socket.IO/WebSockets
- JWT/session management
- Background jobs for notifications/escalations

Mobile target:
- React Native + TypeScript
- Shared API contracts and domain types
- Doctor and nurse operational workflows

## 14. Design system

- Near-black / graphite base
- Teal/cyan medical accent
- 8–16px spacing rhythm
- Rounded cards and restrained glass surfaces
- Strong text hierarchy
- High information density without visual clutter
- Ambient animated background with very low motion amplitude
- Micro-interactions on navigation, filters, dialogs, loading and completion
- Accessible focus/contrast states
- Empty, error, offline and skeleton states for every data-heavy screen

## 15. Security principles

- Never expose passwords or long-lived secrets in the React bundle
- Short-lived access tokens and secure refresh/session handling
- RBAC enforced by backend, not only UI
- Audit sensitive operations
- Explicit confirmation for patient transfer/discharge/destructive actions
- Minimize patient data shown in global notifications
- Separate clinical and financial permissions
