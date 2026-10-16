# Submission checklist

Source: the hackathon page and Official Rules.

**Deadline: Thursday 12 Nov 2026, 12:00 pm Pacific = 1:30 am IST on Fri 13 Nov.** Aim to submit by the evening of Wed 11 Nov (IST) and leave a buffer. Drafts can be saved on Devpost before then; nothing can be changed after.

## Project requirements

- [ ] Meaningfully uses the PayPal developer platform (sandbox): Orders v2, Payments v2 refund, webhooks, idempotency
- [ ] Meaningfully uses AI: Claude for mandate compilation, intent judging, injection detection, remedy proposals
- [ ] Working prototype (not a mockup or non-functional demo)
- [ ] Documented well enough for judges to evaluate (README, docs/)
- [ ] Newly created during the submission period (started Oct 16)

## What to submit on Devpost

- [ ] **Text description** of features and functionality
- [ ] **Tools used** and how: PayPal APIs, Claude, plus any sponsor tools actually used (see README "Hackathon notes")
- [ ] **Functional demo:** run instructions in the repo (done: fake mode needs no credentials) and/or a hosted URL
- [ ] **Public GitHub repo** containing all source, assets and instructions
  - [ ] Repo is public
  - [ ] `LICENSE` is visible in the repo's About section (GitHub detects the MIT file automatically; check it after pushing)
- [ ] **Demo video**
  - [ ] Under 3 minutes (judges need not watch beyond)
  - [ ] Shows the project actually running, on the device it was built for
  - [ ] Uploaded to YouTube and set to **public**; link pasted in the form
  - [ ] No third-party trademarks or copyrighted music without permission: use the fictional "Fernlight" store, keep other companies' logos out of your own slides and graphics, and use no music (or music you own or that is licensed for this use)

## Eligibility and admin

- [ ] Registered on Devpost for the hackathon
- [ ] One person is the Representative if entering as a team
- [ ] All submission materials are in English
- [ ] Anything third-party you integrated is used within its licence terms (this project uses MIT/Apache-style npm packages; check `package-lock.json` if unsure)
- [ ] Keep the project available free of charge for judges until judging ends (Dec 15)

## Strengthen the score before submitting

Judging criteria (equally weighted): Technological Implementation, Design, Potential Impact, Innovation, Presentation.

- [ ] Run the full flow against the **live PayPal sandbox** and the **live Claude API** (the biggest outstanding risk: neither has been exercised yet)
- [ ] Build the owner dashboard (AG Grid) for a complete product feel and a shot at the AG Grid prize
- [ ] Deploy to Render for a hosted demo URL (and a shot at the Render prize)
- [ ] Rehearse the 3-minute video with the beats: risk, mandate, legitimate payment, attack blocked, wrong delivery, merchant-approved refund, audit trail

## Suggested 3-minute video outline

| Time | Beat |
|---|---|
| 0:00 to 0:15 | The problem: agents can spend money, nothing proves they were allowed to |
| 0:15 to 0:40 | Plain English becomes a signed mandate; the readback is rendered by code |
| 0:40 to 1:20 | A legitimate purchase: real sandbox checkout approved by the human payer, then captured |
| 1:20 to 1:55 | The attack: a poisoned page tries to add a gift card; blocked with reasons; kill switch |
| 1:55 to 2:30 | Wrong delivery: diff, AI-proposed remedy, named merchant approves, refund |
| 2:30 to 2:50 | Audit trail intact; architecture in one frame (AI proposes, code decides) |
| 2:50 to 3:00 | What it is for, and the open-source ask |
