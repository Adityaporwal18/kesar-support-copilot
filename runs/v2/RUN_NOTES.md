# v2 run notes (final)
- When: Tue 24 Nov 2026, 20:36-20:51 IST. Sheet: MAIN ("Kesar Support"), cleared before the run.
- Emails: all 25, in file order, each sent once, strictly one at a time (15 s pause, runner waits up to 15 min per email). No single-email reruns, no manual fixes. All 25 requests returned HTTP 200; the slowest took 144.8 s.
- Workflow: workflow/kesar_support_copilot.json (prompts classify_v2.md, agent_system_v2.md).
- Models: classifier Groq openai/gpt-oss-20b (temperature 0); agent Gemini gemini-3.5-flash-lite (temperature 0.2) with Groq openai/gpt-oss-120b as fallback. The fallback wrote part of 5 replies (E02, E04, E05, E08, E12).
- This is the fourth full v2 run. Earlier full runs are kept for transparency:
  - runs/v2_run1 (19:00-19:11): all scored checks passed; reading the drafts found the E05 language problem (change 9).
  - runs/v2_run2 (19:13-19:24): all scored checks passed; reading the drafts found an invented product size in E14, raw dates and markdown (changes 10-13).
  - runs/v2_run3 (19:40-20:10): provider throttling made three replies exceed my runner's timeout, two runs overlapped and one ticket overwrote another (change 14).
