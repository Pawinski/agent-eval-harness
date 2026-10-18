# Program design

These rules decide how files, folders and names are laid out in this repository, and how
issues are written. Each rule exists so that a person can open the repository cold and find
what they need without a guide.

## Files and folders

1. **Readable by a person first.** Write each file so a person can read it top to bottom.
   About 150 lines per file is a guideline, not a hard rule: a longer file that reads well
   is better than a split that scatters one idea across several files.
2. **No numbered or lettered files.** Do not name files or folders by sequence, such as
   `a`, `b`, `c` or `01-`. A sequence says when something was written, not what it holds.
3. **No acronyms or abbreviations in names.** This covers files, folders, classes,
   variables and functions. Write the whole word:
   - `mcp` becomes `modelContextProtocol`, `llm` becomes `languageModel`, `id` becomes
     `identifier`. For `csv`, name what the data holds; failing that, `commaSeparated`.
   - Common short words too: `configuration`, `maximum`, `dollars` (or `currency` where
     needed), `commitHash`.
   - Exception: a key a tool requires, or a field of a third-party API we do not control.
4. **Group by logic, then split by logic.** Keep code that changes together in one place.
   When a group grows, split it along the lines of what it does, and name each file for
   what it holds.
5. **Load order lives in an entry file.** When order matters, express it in one entry file
   that imports the other files by name. Do not encode order in file names.

## Exemptions

These names are exempt from the naming rules above. The list is final.

- Names a tool requires: `AGENTS.md`, `Dockerfile`, `package.json`, `README`,
  `tsconfig.json` and similar, and the `.github/` folder.
- `.env.example`, a tool convention.
- The `src/` and `docs/` folder names.
- Run files under `results/`. They are generated data, not code, so these rules do not
  apply to them and they are never renamed.

## Existing names

Existing names change only when that code is touched for another reason. Nobody renames
files just to follow these rules, and this document renames nothing. When you do touch
code with a name that breaks a rule, rename it in the same change and say so in the pull
request.

Two groups are on a follow-up list: test files named by letter, and files whose name
carries a version suffix. Rename these only with the repository owner's go, even when the
code is touched.

## Issues

Every GitHub issue starts the same way, so a reader knows within seconds what it is about.

- **TL;DR first:** two or three plain sentences saying what is wrong, how bad it is, and
  what happens next.
- **Then a "Filed by" line:** which agent filed it, the date and time in Pacific Time, and
  what that agent was doing when it found the problem.
- **Then the detail:** steps to reproduce, evidence and links.

Questions about these rules go to the repository owner.
