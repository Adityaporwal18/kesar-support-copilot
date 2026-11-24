# v2 run notes (final)
- When: Tue 24 Nov 2026, 19:13-19:24 IST. Sheet: MAIN ("Kesar Support"), cleared before the run.
- Emails: all 25, in file order, each sent once, one at a time, 8 s apart. No reruns of single emails, no manual fixes.
- Workflow: workflow/kesar_support_copilot.json (prompts classify_v2.md, agent_system_v2.md).
- Models: classifier Groq openai/gpt-oss-20b (temperature 0); agent Gemini gemini-3.5-flash-lite (temperature 0.2) with Groq openai/gpt-oss-120b as fallback.
- This is the second full v2 run. The first one (runs/v2_run1, 19:00-19:11) passed every scored check but labelled the Hinglish email E05 as Hindi,
  so its reply was in Devanagari with a transliterated order ID. That was fixed in code (see runs/CHANGELOG_v1_to_v2.md, change 9) and all 25 were run again.
