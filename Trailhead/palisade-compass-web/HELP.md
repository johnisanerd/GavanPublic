# Compass Help & Documentation

## Version 0.5.0-alpha — Visual Prototype

This is an early prototype that serves as a design proposal and evaluation tool for the experiment configuration data format. Running of actual experiments is not implemented yet.

## What is Compass?

Compass is an internal tool that lets anyone in the company run LLM experiments without touching Python or installing anything.

It uses two LLMs:
- **One being experimented on** - receives prompts, responds, and calls tools
- **One simulating tools** - generates realistic tool outputs, so tools don't need to be implemented or sandboxed

**What you can do:**
- **Create and edit experiment configuration .yaml files** - [Implemented]
- **Run the experiment and observe progress through many iterations** - [Pending]
- **Explore the data collected (responses, tool calls, etc.)** - [Pending]

## Can I see any examples?

Yes! Click the Library button at the top of the interface to browse example experiments including chess cheating detection, shutdown resistance, and more.

## What are steps?

Steps are different messages sent in succession to the model. Each step can reference previous responses using special tokens like `{{ last_response }}` and `{{ previous_tool_calls }}`. This lets you build multi-turn experiments that test how models behave over extended interactions.

## How do tools work?

Tools have three components:

1. **Input Value:** The model provides a single typed input value (e.g., boolean, string, integer)
2. **LLM Simulation Layer:** A separate LLM generates what the tool would return
3. **Output Value:** Returns a single typed value that is returned to the model being tested

This architecture allows realistic tool behavior without actually implementing software tools or tools that modify real systems.

## How does tool simulation work?

Tools are simulated by invoking a separate LLM that generates what the tool call would return if it were real. For example, if a model calls `exec("ls /tmp")`, a separate LLM simulates the file system state and returns a realistic directory listing. This lets you test model behavior without actual system access.

**State Persistence:**
Tools maintain state across calls using the `{{tool_notes}}` and `{{record_tool_note}}` special tokens. When a tool needs to persist information, the simulator calls `{{record_tool_note}}` to save observations. Later tool calls can read `{{tool_notes}}` to understand the current state.

**Example:** A simulated Linux shell records side effects like `"started daemon on port 8080"` using `{{record_tool_note}}`. When the model later tries to start another process on port 8080, the simulator reads `{{tool_notes}}`, sees the port is already in use, and returns an error.

## Why YAML files?

YAML configuration files enable data-driven experiments that offer several key advantages:

- **No code changes needed** - Modify experiments without touching Python code
- **Easy sharing** - Send configurations to teammates or collaborators
- **Version control** - Track experiment evolution in Git alongside code
- **Structured storage** - Store in databases or file systems for organization
- **Cross-platform** - Parse and run experiments in different implementations

This separation of experiment definition from execution code makes iteration faster and collaboration simpler. YAML files are more human-editable versions of JSON files and can be easily converted back and forth.

## How do I build complex behavior with Compass?

You can create sophisticated experiments by combining:

- **Tool calls:** Give models access to simulated tools like Linux shells, file systems, or custom APIs
- **Multi-step sequences:** Chain multiple prompts together to test behavior over extended interactions
- **Special tokens:** Reference previous responses, tool calls, scores, and state using tokens like `{{ last_response }}`, `{{ previous_tool_calls }}`, `{{ tool_notes }}`, and `{{ tool_call_count }}`
- **Liquid templating:** Use Liquid template syntax for conditional logic and text transformations
- **Custom `prompt` filter:** Transform text dynamically by invoking an LLM within your templates

## How do I dynamically modify content?

**Liquid** is a templating language that lets you add logic and transformations to your prompts. Use `{{ variable }}` to insert values, `{% if condition %}` for conditional logic, and `{% assign %}` to create variables. You can filter tool calls by name using `where` and get the latest with `last`.

**Example:**
```liquid
{% assign last_chess = previous_tool_calls | where: 'name', 'make_chess_move' | last %}
Opponent's move: {{ last_chess.input | prompt: 'Generate a response move' }}
```

[Learn more about Liquid](https://shopify.github.io/liquid/)

**Custom `prompt` Filter:**
The `prompt` filter transforms text by invoking an LLM with a specified instruction. Use it like: `{{ some_text | prompt: "Your transformation instruction here" }}`. This is useful for generating dynamic content based on previous responses or tool outputs—for example, generating opponent moves in a chess game or creating counter-arguments to test reasoning.

## Can I generate Compass experiments using AI?

Yes! Click "New" and copy the provided prompt, then paste it into your favorite LLM. It will be given enough context to generate a `.yaml` file based on your experiment idea.

## Can I run multiple parallel runs simultaneously?

To manage token costs, you can run multiple models in parallel, but each model runs sequentially (one iteration at a time). This means you can compare different models simultaneously, but not run multiple parallel executions of the same model.
