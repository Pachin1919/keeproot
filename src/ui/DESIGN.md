# Atlas Project Studio Design System

## Visual theme

Atlas uses a restrained dark local-tool aesthetic: alert, precise, dense enough for daily work, and free of dashboard decoration.

- Design variance: 4/10. Stable grid with one asymmetric Decision Inbox.
- Motion intensity: 3/10. Hover, focus, selection, disclosure, and action feedback only.
- Visual density: 8/10. Compact rows, real data, and sparse dividers instead of card grids.

## Color roles

- Deep slate canvas (`#161A1F`): outer application background.
- Working surface (`#20252B`): primary working area.
- Raised slate (`#282E35`): selected rows and quiet controls.
- Soft white ink (`#E7ECE9`): primary text; never pure white.
- Muted steel (`#B8C1BC` high contrast; `#9BA5A0` standard): metadata and secondary text.
- Structural line (`#353C43`): separation without bright grid noise.
- Atlas green (`#72B18C`): the only accent, used for selected state, focus, links, and safe status.

Warning and danger colors are semantic exceptions, never decorative accents.

The installed default uses high-contrast secondary text (`#B8C1BC`). Settings may select Slate, Graphite, or Warm Charcoal backgrounds and one Green, Steel Blue, or Muted Amber accent. Every combination is curated; arbitrary colors are rejected so status contrast remains predictable.

## Typography

- UI: Satoshi when available, then Aptos or Segoe UI Variable.
- Metadata: Geist Mono, Cascadia Code, or Consolas.
- No serif type in the application shell.
- Project titles use 27-34px. The default Comfortable setting uses 16px body text, 14px working rows, and 17px section titles. Compact and Large remain explicit user choices.

## Layout

- Desktop: 58px header, user-resizable 220-420px Project rail, fluid Project workspace, 304px Decision Inbox, 44px Runtime footer.
- The center workspace scrolls independently. Project navigation and Runtime remain stable.
- Below 1120px, Decision Inbox moves out of the persistent frame and remains available through Tasks.
- Below 800px, the shell becomes one column and tables become horizontally scrollable.

## Components

- Project tree: selected Project uses a muted green surface. Counts represent real open Tasks.
- Task table: compact rows with one divider between rows. No standalone row cards.
- Decision Inbox: a single grouped surface, maximum three visible decisions.
- Sources: two-column path grid with truncation and full path in the linked Task.
- Verified output: one quiet green-tinted row, not a dashboard card.
- Technical identity and Rule history stay collapsed until requested.
- Status badges are semantic only. A shared Status guide explains whether Atlas continued, paused, stopped, verified, restored, or lacks a current fact.
- Settings contains display-only preferences: palette, accent, contrast, text size, density, navigation width, and non-essential technical IDs. Project rules, approval policy, Runtime installation, and Ledger facts do not belong in Settings.

## Interaction

- Every visible primary control must navigate, filter, disclose, or execute a real Atlas action.
- Focus rings use Atlas green with visible contrast.
- Active feedback uses a 1px vertical shift. No scroll effects, perpetual motion, or decorative animation.
- Project and primary navigation rails use an accessible separator: pointer drag plus Left/Right/Home/End keyboard control. The width is retained for the current local UI session.
- Reduced-motion mode removes nonessential transitions.

## Banned patterns

- No card grid homepage, KPI strip, fake charts, neon, glass effects, gradients used as decoration, or AI-purple.
- No fake Sources, outputs, agents, timestamps, hashes, or activity.
- No decorative status badges or labels. Health dots and status badges must represent a current Runtime or Task fact.
- No browser-style chrome, marketing hero, AIDA layout, or GSAP scroll effects.
- No hidden core action and no static control that looks clickable.
