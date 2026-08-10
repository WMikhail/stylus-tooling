# Stylelint for Stylus in Zed

Linting is provided by the separate
[Stylelint extension for Zed](https://github.com/florian-sanders/zed-stylelint)
and the [stylelint-stylus](https://stylus.github.io/stylelint-stylus/) syntax
and rules package. The Stylus language server handles semantic navigation; it
does not bundle Stylelint or duplicate Stylelint's lint rules.

## Project setup

Install the linting dependencies in the project that contains the `.styl`
files:

```sh
npm install --save-dev stylelint stylelint-stylus postcss-styl
```

Add a `stylelint.config.mjs` file. This is a small starting point; add or replace
rules to match the project:

```js
export default {
  plugins: ["stylelint-stylus"],
  overrides: [
    {
      files: ["**/*.styl", "**/*.stylus"],
      customSyntax: "postcss-styl",
      rules: {
        "stylus/declaration-colon": "never",
        "stylus/pythonic": "always",
        "stylus/semicolon": "never",
      },
    },
  ],
};
```

Verify the project configuration independently of the editor:

```sh
npx stylelint "**/*.{styl,stylus}"
```

## Zed setup

The current Stylelint extension manifest must include `"Stylus"` in
`[language_servers.stylelint-lsp].languages` before Zed will start its server
for this language. Until that entry is released upstream, check out
`florian-sanders/zed-stylelint`, add `"Stylus"` to that array, and install that
checkout with `zed: install dev extension`. This is the complete manifest-only
change suitable for an upstream pull request:

```toml
languages = [
  "CSS", "SCSS", "LESS", "Sass", "PostCSS", "Stylus",
  # the existing entries follow
]
```

Then add the following to the project `.zed/settings.json`:

```jsonc
{
  "lsp": {
    "stylelint-lsp": {
      "settings": {
        "stylelint": {
          "validate": ["stylus"],
          "customSyntax": "postcss-styl",
        },
      },
    },
  },
}
```

For Stylelint fixes during formatting, add its source action to the Stylus
formatter list:

```jsonc
{
  "languages": {
    "Stylus": {
      "formatter": [{ "code_action": "source.fixAll.stylelint" }],
    },
  },
}
```
