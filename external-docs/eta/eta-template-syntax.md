---
id: template-syntax
title: Template Syntax
---

Eta's syntax will be familiar if you've ever used EJS. You'll get the hang of it in no time!

## Basic Syntax

The data you pass in is available in the `it` variable.

**To output data**, use the `<%=` opening tag.

```eta
Hi <%= it.name %>
```

By default, Eta will automatically XML-escape the data you output. **To allow raw HTML**, use the `<%~` opening tag.

```eta
Hi <%~ it.contentContainingHTML %>
```

**To evaluate JavaScript**, use the `<%` opening tag.

```eta
<% let myVar = 3 %>
```

**Comments** are just like regular JavaScript multiline comments!

```eta
<% /* this is a comment */ %>
```

## Partials and Layouts

Partials are just like regular templates, except they are rendered inside other templates.

**To render a partial**, use the `<%~` opening tag + the `include()` function.

```eta
<%~ include("./path-to-partial") %>
<% /* we can also pass in data that will be merged with `it` and passed to the partial */ %>
<%~ include("./path-to-partial", { option: true }) %>
```

**To render an async partial**, use the `<%~` opening tag + the `includeAsync()` function.

```eta
<%~ await includeAsync("./path-to-partial") %>
```

A template file can only have one parent layout (though layouts themselves can have parents). **To set the parent layout**, use the `layout()` function.

```eta
<% layout("./path-to-layout") %>
```

To render child content in the layout, use `it.body`.

```
<%~ it.body %>
```

### Name Resolution of Partials and Layouts

If you're running Eta in Node.js or Deno, Eta will automatically try to resolve partials and layouts from inside the filesystem. Ex. `<%~ include("/header.eta") %>` will look for a file called `header.eta` in the `views` directory of your project.

But what if you want to include a partial/layout that doesn't exist on the filesystem? Maybe you programatically defined it as a string or loaded it from the internet. There's a solution for that. If you name your template starting with an `@` symbol, Eta will know to look in the internal template storage rather than on the filesystem.

```eta
<%~ include("@header") %>
```

## Whitespace Control

_Note: a "delimiter" means the opening or closing tag._

Opening delimiters can be followed with `-` or `_`, and closing delimiters can be prefixed with `-` or `_`

`_` at the beginning of a tag will trim all whitespace before it, and `_` at the end of a tag will trim all whitespace after it.

`-` at the beginning of a tag will trim 1 newline before it, and `-` at the end of a tag will trim 1 newline after it.

```eta
Hi
<%- = it.myname %>
<% /* %The newline after "Hi" will be stripped */ %>
```

---
id: syntax-cheatsheet
title: Syntax Cheatsheet
---

## Conditionals

```eta
<% if (it.someval === "someothervalue") { %>
Display this!
<% } else { %>
They're not equal
<% } %>
```

## Looping over arrays

```eta
<% users.forEach(function(user){ %>
  <%= user.first %> <%= user.last %>
<% }) %>
```

## Looping over objects

```eta
<% Object.keys(someObject).forEach(function(prop) { %>
  <%= someObject[prop] %>
<% }) %>
```

## Logging to the console

```eta
<% console.log("The value of it.num is: " + it.num) %>
```

## Async Partials

```eta
<%~ await includeAsync("./path-to-partial") %>
```