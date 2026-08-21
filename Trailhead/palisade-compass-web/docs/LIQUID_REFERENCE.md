# Liquid Template Reference for Compass

This is a condensed reference of Liquid templating features used in Compass experiments. Based on Shopify's open-source Liquid template language (https://shopify.github.io/liquid/).

## Core Syntax

Liquid uses two types of delimiters:

- **Objects** `{{ }}` - Output dynamic content
- **Tags** `{% %}` - Define logic and control flow

## Output (Objects)

Use `{{ }}` to output values:

```liquid
{{ variable }}
{{ last_response }}
{{ step_number }}
```

**Examples:**
```liquid
{{ tool_call.name }}
The current step is: {{ step_number }}
Previous output: {{ previous_tool_calls | last | output }}
```

## Variables

Create variables with `assign`:

```liquid
{% assign variable_name = value %}
```

**Examples:**
```liquid
{% assign count = 0 %}
{% assign last_exec = previous_tool_calls | where: 'name', 'exec' | last %}
{% assign is_final = step_number >= 10 %}
```

## Conditionals

Control flow with if/elsif/else:

```liquid
{% if condition %}
  ...
{% elsif other_condition %}
  ...
{% else %}
  ...
{% endif %}
```

**Comparison operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`
**Logical operators:** `and`, `or`
**Special values:** `true`, `false`, `nil`

**Examples:**
```liquid
{% if step_number == 1 %}
  This is the first step
{% endif %}

{% if tool_call_count > 5 and score == 0 %}
  Alert: Multiple tool calls with no score
{% endif %}

{% assign last_call = previous_tool_calls | last %}
{% if last_call.name == "exec" %}
  Last command: {{ last_call.input }}
{% endif %}
```

## Filters

Chain filters with `|` to transform values:

```liquid
{{ value | filter }}
{{ value | filter: argument }}
{{ value | filter1 | filter2 }}
```

### Array Filters

**`where: 'property', 'value'`** - Filter array by property value
```liquid
{% assign exec_calls = previous_tool_calls | where: 'name', 'exec' %}
{% assign failed_tools = previous_tool_calls | where: 'status', 'error' %}
```

**`first`** - Get first item in array
```liquid
{% assign first_call = previous_tool_calls | first %}
```

**`last`** - Get last item in array
```liquid
{% assign last_call = previous_tool_calls | last %}
{% assign last_exec = previous_tool_calls | where: 'name', 'exec' | last %}
```

**`size`** - Get array or string length
```liquid
{% assign call_count = previous_tool_calls | size %}
{% if previous_tool_calls | size > 10 %}Too many calls{% endif %}
```

### String Filters

**`default: value`** - Provide default if nil/empty
```liquid
{{ tool_output | default: "No output" }}
```

**`upcase`** - Convert to uppercase
```liquid
{{ "warning" | upcase }}  <!-- OUTPUT: WARNING -->
```

**`downcase`** - Convert to lowercase
```liquid
{{ status | downcase }}
```

**`capitalize`** - Capitalize first letter
```liquid
{{ title | capitalize }}
```

**`strip`** - Remove whitespace
```liquid
{{ user_input | strip }}
```

### Math Filters

**`plus`**, **`minus`**, **`times`**, **`divided_by`**
```liquid
{% assign next_step = step_number | plus: 1 %}
{% assign half = iterations | divided_by: 2 %}
```

### Custom `prompt` Filter (Compass-specific)

The `prompt` filter is unique to Compass. It invokes an LLM to transform or generate text:

```liquid
{{ text | prompt: "instruction for the LLM" }}
```

**Examples:**
```liquid
{{ last_chess.input | prompt: 'Generate a chess response move in algebraic notation' }}

{{ last_response | prompt: 'Create a counter-argument to this claim' }}

{% assign opponent_move = last_tool_call.input | prompt: 'What would be a reasonable next move?' %}
Opponent plays: {{ opponent_move }}
```

## Comments

```liquid
{% comment %}
This won't appear in output.
Useful for documentation and temporarily disabling code.
{% endcomment %}
```

## Object Access

Access object properties with dot notation:

```liquid
{{ tool_call.name }}
{{ tool_call.input }}
{{ tool_call.output }}
{{ last_response.length }}
```

**Accessing nested properties:**
```liquid
{% assign last_exec = previous_tool_calls | where: 'name', 'exec' | last %}
Command: {{ last_exec.input }}
Result: {{ last_exec.output }}
```

## Complete Examples

### Example 1: Filter and display last exec command

```liquid
{% assign last_exec = previous_tool_calls | where: 'name', 'exec' | last %}
{% if last_exec %}
  Last command executed: {{ last_exec.input }}
  Output: {{ last_exec.output }}
{% else %}
  No commands executed yet
{% endif %}
```

### Example 2: Conditional logic based on step number

```liquid
{% if step_number == 5 %}
  ALERT: System shutdown imminent!
{% elsif step_number > 5 %}
  System is shutting down...
{% else %}
  Normal operation
{% endif %}
```

### Example 3: Dynamic opponent moves with prompt filter

```liquid
{% assign last_move = previous_tool_calls | where: 'name', 'make_chess_move' | last %}
{% assign opponent_move = last_move.input | prompt: 'The chess move was {{input}}. Generate a reasonable black response move in algebraic notation. Return only the move.' %}

Opponent's move: {{ opponent_move }}
Your turn.
```

### Example 4: Counting and conditional responses

```liquid
{% assign exec_count = previous_tool_calls | where: 'name', 'exec' | size %}
{% if exec_count > 10 %}
  You've executed {{ exec_count }} commands. Consider your actions carefully.
{% elsif exec_count > 0 %}
  {{ exec_count }} commands executed so far.
{% else %}
  No commands executed yet.
{% endif %}
```

### Example 5: Accessing tool notes for state

```liquid
{% comment %}In a tool simulatorPrompt{% endcomment %}
Read {{tool_notes}} to understand the current system state.

{% if tool_notes contains "daemon on port 8080" %}
  Error: Port 8080 is already in use
{% else %}
  Starting daemon on port 8080...
  Call {{record_tool_note}} with "started daemon on port 8080"
{% endif %}
```

## Best Practices

1. **Use meaningful variable names**
   ```liquid
   {% assign last_exec_call = previous_tool_calls | where: 'name', 'exec' | last %}
   ```

2. **Check for nil before accessing properties**
   ```liquid
   {% if last_call %}
     {{ last_call.output }}
   {% endif %}
   ```

3. **Chain filters for clarity**
   ```liquid
   {{ previous_tool_calls | where: 'name', 'exec' | last | output | default: "No output" }}
   ```

4. **Use comments for complex logic**
   ```liquid
   {% comment %}Check if model attempted to bypass restrictions{% endcomment %}
   {% assign suspicious = previous_tool_calls | where: 'name', 'exec' | size %}
   {% if suspicious > 5 %}...{% endif %}
   ```

## Resources

- Official Liquid Documentation: https://shopify.github.io/liquid/
- Liquid Basics: https://shopify.dev/docs/api/liquid/basics
- LiquidJS (implementation used): https://liquidjs.com/
