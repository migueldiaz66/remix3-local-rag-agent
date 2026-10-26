# Notes: RAG practice, and the frameworks that could replace the hand-made parts

This file is a memory for a future maintainer of this project. The project hand-writes the small
parts of a RAG on purpose, so that every stage is visible: the chunking (`app/ai/chunk.ts`), the
prompt and the retrieval (`app/ai/rag.ts`), the agent loop (`app/ai/agent.ts`) and the chat panel
(`app/actions/public/chat-panel.tsx`). These notes explain what those parts do, how professional
RAG services handle the same stages, and which open-source tools could replace each part if the
project grows, so that the choice can be made with the facts in hand. How the pieces work together
is in [architecture.md](architecture.md); how to run the project is in [../README.md](../README.md).

| Hand-written part | Where | Open-source tools that could replace it | Questions |
|---|---|---|---|
| Chunking | `app/ai/chunk.ts` | The chunking strategies of a framework (LlamaIndex, LangChain); a document parser (Docling, Unstructured) once the corpus is no longer Markdown | 1, 2, 3, 4 |
| Prompt and retrieval | `app/ai/rag.ts`, `app/ai/qdrant.ts` | A framework's query engine or pipeline (LlamaIndex, Haystack); components for hybrid search and reranking | 3, 4 |
| The agent loop | `app/ai/agent.ts` | A framework (LlamaIndex, LangChain); the in-app assistant idea of CopilotKit | 4, 5 |
| The chat panel | `app/actions/public/chat-panel.tsx` | Deep Chat (a web component); assistant-ui or CopilotKit (React, in an island) | 5 |

Which tool replaces which part is a reading of the descriptions in questions 4 and 5. No tool named
here has been tried in this project. The answers were written on 25 October 2026 from the code, the
transcripts in `docs/transcripts/` and the web sources listed under them; the field moves quickly,
so read each project's own documentation before adopting anything.

---

## Question 1

> What is a passage?

### Answer

A passage is one slice of the article, the piece the RAG works with. "Chunk" is the usual word; the
code uses it (`chunk.ts`, the `Chunk` type), and the prose says "passage" to mean the same thing.

**What one looks like.** A passage is a run of consecutive lines of `data/rag-wikipedia.md`, kept
together with five facts. Here is the passage on chunking, `improvements-9`:

| Field | Value |
|---|---|
| `id` | `improvements-9` |
| `chapter` | `Improvements`, the nearest `##` heading above it |
| `heading` | `Chunking`, the nearest heading of any level above it |
| `lines` | `[69, 71]`, the first and last line in the file |
| `text` | the lines themselves, exactly as written, 129 characters |

Its text is the sub-heading and the one sentence under it:

```
### Chunking

Chunking involves various strategies for breaking up the data into vectors so the retriever can
find details in it.
```

(In the file the sentence is one line.) The panel and the prompt call this passage "Improvements,
Chunking, lines 69-71".

**How the article is cut.** The rules in `chunk.ts`:

- A passage never crosses a `##` or a `###` heading, so each belongs to exactly one section, and
  the chunker never merges the end of one section with the start of the next. A `##` line is not
  inside any passage; a `###` line is, and stays with the paragraph under it, as above.
- Blocks (paragraphs, list items, tables, fenced blocks) under one heading are packed into
  pieces of about 500 characters (`DEFAULT_MAX_CHARS`, `config.chunkMaxChars`, the environment
  variable `CHUNK_MAX_CHARS`). A block is never cut, so a passage can be longer than 500: 7 of the
  25 are, the longest at 945 characters, which is one paragraph of "RAG and LLM limitations".
- The crumb rule: a piece shorter than a quarter of the maximum (125 characters) joins a
  neighbour inside the same heading. A piece alone under its heading stays as it is:
  `improvements-1`, 91 characters, is the one sentence that introduces the chapter "Improvements".

The result on the article: 25 passages in 6 chapters, from 91 to 945 characters, median 384. The
article has 30 body paragraphs, so most passages are one paragraph. The ingest of the 25 takes
9 seconds on this machine.

**Why that size.** Two reasons pull in opposite directions. Smaller passages match a question more
precisely, because the vector of a short text is about one thing. Larger passages give the model
more context to answer from. When ten test questions were measured at 500, 800, 1,200 and 1,500
characters, 500 was chosen: the right passage was in the top 4 for 10 of 10 questions and first
for 6 of 10. And on this machine there is a third constraint: every passage sent to the model is
prompt text it must process at about 44 tokens per second.

**What happens to each passage.**

1. `scripts/ingest.ts` sends its text to `nomic-embed-text`, which returns a vector of 768 numbers
   that stands for its meaning. The chapter name is put in front of the text, with nomic's
   `search_document: ` task prefix, so the vector knows its context (`documentInput` in `rag.ts`).
2. The vector and the five fields above are stored together in Qdrant as one point, in a
   collection that compares vectors by cosine similarity.
3. At question time the question is embedded the same way (with the `search_query: ` prefix),
   Qdrant returns the 4 passages whose vectors are closest, the panel lists them as sources, and
   the model reads them as numbered passages. For "What is chunking in RAG?" the four were
   `rag-and-llm-limitations-2` (score 0.682), `improvements-9` (0.679), `process-2` (0.655) and
   `retrieval-augmented-generation-2` (0.654), 1,542 characters in all. The passage on chunking
   came second, by 0.003: short passages of a short article score close to each other.

**One limit that does not bite here.** The embedding model reads at most 2,048 tokens of a text.
The longest passage, 945 characters, is far below that, so no vector leaves out the end of its
passage. With a corpus of long tables, that would not be true.

---

## Question 2

> Why use passages, and not simply convert the whole document to one vector?

### Answer

Because a vector stands for one text, and the more topics a text covers, the less any single
question is near it. For this project the case is weaker than for a long document, and the honest
version of the answer says which arguments hold and which do not.

**What a vector is.** The embedding model reads a text and returns 768 numbers that place its
meaning as a point in a space: texts that mean similar things land close together. A question is
placed the same way, and the search returns the texts nearest to it.

The article is short: about 10 KB, roughly 2,500 tokens. That matters for the three arguments.

**1. One vector per document would be an average of everything in it. This holds.** The article
covers what RAG is, the limits of language models, the process, applications such as healthcare,
the encoder, retriever-centric methods, the language model, chunking, hybrid search and poisoning.
Its single vector would sit somewhere in the middle of all of that. The passage on chunking is 129
characters out of 10,310, about 1 percent of the article; a passage about chunking lands next to
questions about chunking, and the whole article would land next to questions that are about RAG in
general. This was not measured here: the project never embedded the whole article to compare.

**2. The answer has to point somewhere. This holds.** The panel shows "Improvements, Chunking,
lines 69-71". That is only possible because the thing that was found is a small, located piece.
A hit on the whole article would say "it is in the article", and the reader would have to look for
it, even in a corpus of one document.

**3. The models have limits. This is weaker here.** For a long document it would be decisive; for
this article it is a matter of speed and headroom:

- The embedding model stops at 2,048 tokens, and the article is about 2,500, so about the last 18
  percent would be missing from the vector, roughly from the "Hybrid search" section on, if the
  tokens are spread evenly through the text (an estimate, not measured). That is a loss, not a
  failure: the vector would still exist.
- The chat model's context window is 4,096 tokens, so the whole article would fit, with about
  1,600 tokens left for the instructions, the question and the answer.
- But the prompt would cost time. At 44 tokens per second the article is about 57 seconds of
  prompt processing before the first word of the answer (2,500 divided by 44, a calculation, not
  a measurement). The RAG mode sends 4 passages, about 15 percent of the article's characters, and
  showed its sources at 0.4 s and finished its answer at 16.3 s.

**So the passage is the right size at both ends.** It is small enough that its vector means one
thing and the search is precise, and large enough that the chat model gets a complete thought to
answer from. The size is the trade-off: smaller passages match more precisely but give less
context; larger ones the reverse. Some services pass whole documents to the model when the
corpus is small and the context window is large (see question 3). This article is such a corpus;
a larger-context model or faster hardware would make "the whole article in the prompt" a fair
baseline to compare against. On this CPU with a 4,096-token context it is not, and the passages
are also what the canvas teaches: documents, chunking, embedding, vector store.

**There are other ways to split.** Fixed windows of N tokens with overlap are the simplest and are
blind to structure. Splitting by headings and paragraphs, as this project does, keeps each passage
a coherent piece and gives it a chapter and a line range for free. Smarter schemes exist: a short
note per passage embedded alongside it, or a hierarchy where a larger section is given to the
model after a small passage was found. Search by meaning also answers prose questions well and
exact questions badly, which is why the article itself has a "Hybrid search" section.

---

## Question 3

> How do professional AI services handle files of information, what are the best practices, and
> are passages a best practice?

### Answer

Short answer: yes. Every production RAG system splits documents into passages; nobody embeds whole
documents. The difference between a small project and a professional service is everything around
that step.

**Passages are universal.** Every professional RAG service splits documents into chunks before
embedding, for the reasons from question 2: one vector means one thing, and the models have
limits. This project's way of splitting, at headings and paragraphs, with each chunk carrying its
chapter and lines, is the mainstream recommendation. What separates it from a professional service
is the rest of the pipeline.

**What production RAG does, stage by stage**

| Stage | What this project does | What a professional service adds |
|---|---|---|
| **Parsing** | Reads one Markdown file, `data/rag-wikipedia.md`, already converted from the article's plain-text extract (see `data/NOTICE.md`) | Handles PDFs, scans, tables and layouts with a document parser; the hardest part for real corpora |
| **Chunking** | Headings and paragraphs, about 500 characters, blocks never cut, no overlap between neighbours; 25 passages | The same idea, with more care: tested chunk sizes (around 512 tokens is a common winner), overlap between neighbors, and "small-to-big": small chunks for the search, their larger parent section for the model |
| **Enriching each chunk** | Puts the chapter name in front of the text before embedding, and nomic's task prefix | **Contextual retrieval:** an LLM writes a short note per chunk saying what it is about within the document, prepended before embedding. Anthropic reported it cuts retrieval failures by about 35%, 49% with keyword search added |
| **Search** | Vectors only: cosine similarity in Qdrant, 4 passages | **Hybrid:** vectors plus keyword search (BM25), merged by rank. Vectors catch paraphrases; keywords catch exact terms, codes and identifiers, such as "Retro++" |
| **Ranking** | Takes the 4 best by vector distance | **Two stages:** pull 20 to 100 candidates cheaply, then a reranker reads each against the question and keeps the best 5 to 10. Reported to raise the gain to about 67% |
| **Filtering** | None: one article, one collection | Metadata filters: by customer, document, date, permissions. Each user sees only what they may |
| **Generation** | One prompt with 4 numbered passages labelled with their section and lines; answer only from them, cite the section, say so when they do not cover the question. Sometimes the model cites a passage by number, not by section | The same, plus query rewriting, answers that quote and link, and guards against answering outside the sources |
| **Evaluation** | Ten questions with a known right passage, measured at four chunk sizes: right passage in the top 4 for 10 of 10, first for 6 of 10. Answer quality was not scored | A test set of questions with known right passages; retrieval measured separately from the answer (recall@k, MRR); monitored in production. The guides agree: most failures come from ingestion and retrieval, not from the model |

**What this means for the project.** Its passages are a best practice in shape; what it lacks is
the layers above. The gap between "in the top 4" (10 of 10) and "first" (6 of 10) is the gap a
reranker exists to close. If the project grew, the order to add them in:

1. **Hybrid search.** Qdrant supports keyword vectors natively, so it is a small step, with the
   largest gain for text full of identifiers and exact terms. The article describes the idea in
   its own "Hybrid search" section.
2. **A reranker.** Small open rerankers run on a CPU; the cost per question on this machine was not
   measured.
3. **Contextual notes per chunk** at ingest time: a one-time cost, paid once per document. The
   passage on chunking is one sentence; a note saying that it is about preparing the data for
   the retriever, in the chapter on improvements, would give its vector more to work with.
4. **A larger evaluation set**: the ten questions kept as a repeatable script, grown, with
   recall@k and MRR, to measure each change instead of guessing.

**Two caveats.** The numbers above come from vendor and practitioner write-ups, and some repeat
each other; Anthropic's figures were reproduced independently with close results. And the field is
moving: as context windows grow, some services pass whole documents to the model for small corpora,
but for anything large or shared between many customers, retrieval over passages remains the
standard, because precision, cost and access control all depend on it.

Sources:

- [Building production RAG: architecture, chunking, evaluation and monitoring, 2026 guide (Prem
  AI)](https://blog.premai.io/building-production-rag-architecture-chunking-evaluation-monitoring-2026-guide)
- [RAG in production in 2026, beyond naive chunk and embed (DEV
  Community)](https://dev.to/ai_builder/rag-in-production-in-2026-beyond-naive-chunk-and-embed-3803)
- [Production RAG: patterns, pitfalls and what works,
  2026](https://www.aitraining2u.com/blog/production-rag-patterns-2026.html)
- [Building production RAG systems (Machine Learning at
  Scale)](https://www.machinelearningatscale.com/blog/building-production-rag-systems)
- [RAG context window limits: why bigger is not
  better](https://www.kunalganglani.com/blog/rag-context-window-limitations.md)
- [Optimizing RAG for maximum performance in your enterprise (Lucent
  Innovation)](https://www.lucentinnovation.com/resources/it-insights/optimizing-rag-for-maximum-performance)
- [A practical guide to RAG implementation
  (Interexy)](https://interexy.com/rag-implementation-best-practices)
- [Anthropic introduces contextual retrieval
  (CO/AI)](https://getcoai.com/news/anthropic-introduces-contextual-retrieval-to-boost-accuracy-of-rag-systems)
- [Anthropic contextual retrieval
  (InfoQ)](https://www.infoq.com/news/2024/09/anthropic-contextual-retrieval/)
- [Reproduction of Anthropic's contextual retrieval results (Denser
  AI)](https://denser.ai/blog/compare-open-source-paid-models-anthropic-dataset/)
- [Contextual retrieval cookbook
  (LlamaIndex)](https://developers.llamaindex.ai/python/examples/cookbooks/contextual_retrieval/)
- [Reconstructing context: evaluating advanced chunking strategies for RAG
  (arXiv)](https://arxiv.org/pdf/2504.19754)
- [Why context is not all you need, a critique
  (Medium)](https://medium.com/almond-ai/responding-to-anthropics-contextual-retrieval-for-rag-apps-why-context-is-not-all-you-need-af503985aa55)

---

## Question 4

> Are there tools on the market that do this, and are they open source?

### Answer

Yes on both counts. The market splits into four kinds of tool; the first three have solid
open-source options, and the fourth is commercial.

**1. Complete RAG platforms** (parsing, chunking, search, chat, a UI): install and point them at
your documents.

| Tool | License | Notes |
|---|---|---|
| **RAGFlow** | Apache 2.0 | Best known for parsing hard documents: PDFs with tables, scans, layouts. Hybrid search, reranking, a graph option, a visual UI. Runs in Docker |
| **Dify** | Open source, with some restrictions | A visual builder for chat apps and agents with a RAG engine inside. Popular with teams that want a product, not a library |
| **Kotaemon** | Apache 2.0 | A chat-over-documents UI with hybrid search and reranking, lighter than the two above |
| **Open WebUI, AnythingLLM** | Open source | Chat interfaces for local models, with document upload and a basic RAG. The closest to what this project does, with a UI already made |

**2. Frameworks** (libraries you build a pipeline with): what the project's `app/ai/` folder is a
hand-made version of.

| Tool | License | Notes |
|---|---|---|
| **LlamaIndex** | MIT | Data connectors, chunking strategies, indexes, query engines; the most RAG-focused. Python and TypeScript |
| **LangChain** | MIT | The widest ecosystem, includes RAG among much else. Python and TypeScript |
| **Haystack** | Apache 2.0 | Pipelines built for production, with evaluation tooling. Python |

**3. Components** for one stage each:

| Stage | Open source | Commercial |
|---|---|---|
| Document parsing | Docling (IBM), Unstructured | LlamaParse, Azure Document Intelligence |
| Embeddings | nomic-embed, BGE, E5 | OpenAI, Cohere, Voyage, Google |
| Vector database | **Qdrant**, Weaviate, Milvus, pgvector in PostgreSQL | Pinecone, and the hosted editions of the open ones |
| Reranking | BGE-Reranker, Jina Reranker | Cohere Rerank, Voyage Rerank |
| Evaluation | Ragas, DeepEval | LangSmith, Braintrust |

**4. Managed services**, where the whole pipeline is a cloud product: Azure AI Search, Amazon
Bedrock Knowledge Bases, Google Vertex AI Search, Vectara. They suit teams already on one cloud;
prices vary a lot, and the sources disagree on the exact figures.

**What this means for the project.** It already uses open-source components at three stages:
Qdrant for the vectors, the Nomic embeddings, and Ollama with `qwen3:1.7b` for the answers. The
first two are the same ones production systems use. What it hand-writes is the glue: chunking, the
prompt, the agent loop. For this project that is the right call, because its point is to show every
stage small and visible: the canvas draws nine stages, and each is a few files. A platform or a
framework would hide the stages the canvas draws. If the project grew, the glue could stay in
TypeScript (LlamaIndex and LangChain both have TypeScript versions) rather than adopt a platform,
adding components: Qdrant's hybrid search, an open reranker, Ragas-style evaluation, and a document
parser such as Docling or Unstructured the day the corpus is no longer a Markdown file.

Note that most of the comparison pages below are written by vendors or affiliates and sometimes
disagree; each project's own docs are the reliable source.

Sources:

- [Open-source RAG frameworks (Olostep)](https://www.olostep.com/blog/open-source-rag-frameworks)
- [The 8 best RAG tools in 2026 (Dupple)](https://dupple.com/learn/best-rag-tools)
- [Best retrieval-augmented generation tools in 2026 (iTech
  Guides)](https://www.itechguides.com/best/retrieval-augmented-generation-tools/)
- [RAGFlow alternatives (Respan)](https://respan.ai/market-map/ragflow/alternatives)
- [Haystack alternatives (Respan)](https://www.respan.ai/market-map/haystack/alternatives)
- [LlamaIndex vs RAGFlow (Respan)](https://respan.ai/market-map/compare/llamaindex-vs-ragflow)
- [Haystack vs Dify (Toolhalla)](https://toolhalla.ai/compare/haystack-vs-dify)
- [LlamaIndex vs Dify (Toolhalla)](https://toolhalla.ai/compare/llamaindex-vs-dify)
- [LlamaIndex alternatives (MyClaw)](https://myclaw.ai/ar/blog/llamaindex-alternatives)
- [Best RAG tools in 2026: frameworks, managed platforms and search engines
  (Rework)](https://resources.rework.com/tools/ai-data-infra/best-rag-tools-2026)
- [RAG in 2026: open-source frameworks or managed platforms (DEV
  Community)](https://dev.to/moksh/rag-in-2026-picking-between-open-source-frameworks-and-managed-platforms-5e84)
- [RAG-as-a-service providers guide 2026 (Groovy
  Web)](https://www.groovyweb.co/blog/rag-as-a-service-providers-guide-2026)
- [Top RAG-as-a-service platforms 2026 (Deepak
  Gupta)](https://guptadeepak.com/tools/top-5-rag-as-a-service-platforms-2026/)
- [Best enterprise RAG platforms 2026
  (PuppyOne)](https://www.puppyone.ai/en/blog/rag-platforms-for-enterprise-in-2026)
- [Azure AI Search alternatives for technical documentation
  (kapa.ai)](https://www.kapa.ai/library/azure-ai-search-alternatives-for-technical-documentation)
- [Top Google Vertex AI alternatives 2026
  (kapa.ai)](https://www.kapa.ai/library/top-9-google-vertex-ai-alternatives-(2026))
- [Best RAG platforms and tools
  (DevToolLab)](https://devtoollab.com/blog/best-rag-platforms-and-tools)

---

## Question 5

> Is there a specialized open-source chat UI for AI frameworks?

### Answer

Yes, several, all open source. They fall into two groups: components you put inside your own app,
and complete chat applications.

**Components to put inside your own app**

| Library | Built for | What it gives |
|---|---|---|
| **assistant-ui** | React | The most complete chat kit: streaming, tool calls shown as cards, message branching, threads, attachments, approval of tool actions. Styled with shadcn/ui and Tailwind |
| **Vercel AI SDK + AI Elements** | React, Next.js | `useChat` plus ready components for messages, reasoning, tool calls and sources. The AI SDK core is also the de-facto standard for the streaming protocol between server and chat |
| **CopilotKit** | React | A chat panel that is also an in-app copilot: the assistant can read the app's state and call actions in it. The closest to "ask the assistant about the app the UI is on top of" |
| **Deep Chat** | Any framework, a web component | One `<deep-chat>` element with streaming, files, speech, and connectors to OpenAI, Ollama and others. Framework-agnostic |
| **NLUX** | React and plain JavaScript | A lighter chat component with adapters for several providers |
| **Ant Design X** | React | Ant Design's AI components: conversations, prompts, thought chains, streaming |
| **LlamaIndex ChatUI** | React | Chat components tuned for RAG answers, with sources and citations |

**Complete chat applications**, for self-hosting rather than embedding: Open WebUI and LibreChat
(ChatGPT-style apps over local or cloud models, with document upload), Hugging Face chat-ui, Lobe
Chat. Chainlit, Gradio and Streamlit give a chat UI to a Python backend with a few lines.

**What this means for the project.** Remix 3 is not React, which narrows the choice. The current
panel, `chat-panel.tsx`, is a Remix component. It has the three modes (LLM, RAG, agent), the input,
the streamed answer, the sources, the tool lines, a Stop button and the "About: Chunking" chip for
the node selected in the canvas. It reads the server's stream of JSON lines (events `token`,
`sources`, `tool`, `ui`, `done` and `error`) and talks to the canvas through two browser events,
`ui:node-selected` and `ui:highlight-node`, defined in `events.ts`. Any replacement has to keep
those two events, or the agent could no longer highlight a stage.

- **Deep Chat** fits the Remix page directly, because a web component does not care about the
  framework. In `app/actions/page.tsx` the `<deep-chat>` element would take the place of
  `<ChatPanel>`. A Remix component can set the element's properties once it is in the document
  with a `ref`, the pattern `flow-island.tsx` uses to start React. The server's JSON-lines stream
  would need a small adapter, or a switch to one of the formats Deep Chat supports, and the sources
  list, the tool lines and the node chip would have to be rebuilt around it. Whether its script can
  be served as it is by the Remix asset server, which accepts only ES modules, or must be bundled
  with esbuild like the canvas, has not been checked.
- **assistant-ui** or **CopilotKit** would go in a second React island, exactly like React Flow:
  Remix renders a placeholder `<div>` and the browser mounts React into it. The React code needs
  a bundle, because React ships CommonJS only and the asset server refuses it;
  `scripts/build-flow.ts` is the recipe, and the chat could join the same bundle. That is more
  code, but CopilotKit's idea is an assistant that reads the app's state and acts in it, and this
  project's three tools (`highlight_node`, `search_docs`, `get_flow`) and its two browser events
  are a hand-made version of that.
- The **Vercel AI SDK's streaming protocol** is worth adopting on the server regardless of the UI,
  because most of these components speak it, so the panel could later be swapped without touching
  the server.

The hand-written panel was the right call for this project: one file, everything visible, no
framework dispute. If the chat had to grow, the choice would be between CopilotKit in an island and
Deep Chat in Remix, after a one-day trial of each.

Sources:

- [assistant-ui alternatives: 8 AI chat UI libraries, 2026
  (DesignRevision)](https://designrevision.com/alternatives/assistant-ui)
- [Best open-source AI chatbot frameworks in 2026
  (fast.io)](https://fast.io/resources/best-open-source-ai-chatbot-frameworks/)
- [assistant-ui vs GenSphere (AI Agents
  Directory)](https://aiagentsdirectory.com/compare/assistant-ui-vs-gensphere)
- [assistant-ui vs PrivateGPT (AI Agents
  Directory)](https://aiagentsdirectory.com/compare/assistant-ui-vs-privategpt)
- [assistant-ui vs AtomicComponents
  (Toolmage)](https://www.toolmage.com/en/compare/assistant-ui-vs-atomiccomponents/)
- [LlamaIndex ChatUI (parse.gl listing)](https://www.parse.gl/brands/ui-llamaindex-ai)
