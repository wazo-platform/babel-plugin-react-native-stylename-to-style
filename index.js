module.exports = function(babel) {
  var attribute = null;
  var style = null;
  var specifier = null;
  var randomSpecifier = null;
  var t = babel.types;

  function isRequire(node) {
    return (
      node &&
      node.declarations &&
      node.declarations[0] &&
      node.declarations[0].init &&
      node.declarations[0].init.callee &&
      node.declarations[0].init.callee.name === "require"
    );
  }

  function generateRequire(name) {
    var require = t.callExpression(t.identifier("require"), [
      t.stringLiteral("react-native-dynamic-style-processor")
    ]);
    var d = t.variableDeclarator(name, require);
    return t.variableDeclaration("var", [d]);
  }

  function generateProcessCall(expression, state) {
    state.hasTransformedClassName = true;
    expression.object = t.callExpression(
      t.memberExpression(state.reqName, t.identifier("process")),
      [expression.object]
    );
    return expression;
  }

  function getStylesFromClassNames(classNames, state) {
    return classNames
      .map(c => {
        var parts = c.split(".");
        var hasParts = parts[0] !== undefined && parts[1] !== undefined;

        if (specifier && !hasParts) {
          return;
        }

        var obj = hasParts ? parts[0] : randomSpecifier.local.name;
        var prop = hasParts ? parts[1] : c;
        var hasHyphen = /\w+-\w+/.test(prop) === true;

        var memberExpression = t.memberExpression(
          t.identifier(obj),
          hasHyphen ? t.stringLiteral(prop) : t.identifier(prop),
          hasHyphen
        );
        return generateProcessCall(memberExpression, state);
      })
      .filter(e => e !== undefined);
  }

  // Support dynamic attribute
  // TODO: Add support for multiple named imports
  // Generates the following:
  //   attribute={x}
  //   | | |
  //   V V V
  //
  //   attribute={
  //     (x || '').split(' ').filter(Boolean).map(function(name) {
  //       return require('react-native-dynamic-style-processor').process(_Button2.default)[name]
  //     }
  //   }
  // The current drawbacks are:
  //   - can be used when there is only one style import
  //   - even when the single style import is named, that name should not be
  //     present in expression calculation.
  //     Example:
  //       import foo from './Button.css'
  //       let x = 'wrapper' // NOT 'foo.wrapper'
  //       <View attribute={x} />
  function getStyleFromExpression(expression, state) {
    var obj = (specifier || randomSpecifier).local.name;
    var expressionResult = t.logicalExpression(
      "||",
      expression,
      t.stringLiteral("")
    );
    var split = t.callExpression(
      t.memberExpression(expressionResult, t.identifier("split")),
      [t.stringLiteral(" ")]
    );
    var filter = t.callExpression(
      t.memberExpression(split, t.identifier("filter")),
      [t.identifier("Boolean")]
    );
    var nameIdentifier = t.identifier("name");
    var styleMemberExpression = t.memberExpression(
      t.identifier(obj),
      nameIdentifier,
      true
    );
    var aRequire = generateProcessCall(styleMemberExpression, state);
    var map = t.callExpression(
      t.memberExpression(filter, t.identifier("map")),
      [
        t.functionExpression(
          null,
          [nameIdentifier],
          t.blockStatement([t.returnStatement(aRequire)])
        )
      ]
    );
    return map;
  }

  return {
    post() {
      randomSpecifier = null;
    },
    visitor: {
      Program: {
        enter(path, state) {
          state.reqName = path.scope.generateUidIdentifier(
            "react-native-dynamic-style-processor"
          );

          if (state.opts.addImport) {
            path.unshiftContainer("body", t.importDeclaration([], t.stringLiteral(state.opts.addImport)));
          }
        },
        exit(path, state) {
          var extensions = state.opts != null && Array.isArray(state.opts.extensions) && state.opts.extensions;

          if (!state.hasAttribute && state.opts.addImport) {
            // Remove import for non jsx file, allow extension like `.css.ts`
            const idx = path.get('body').findIndex(p => p.isImportDeclaration() && extensions.findIndex(ext => p.node.source.value.endsWith(ext)) !== -1);
            if (idx !== -1) {
              path.get('body')[idx].remove();
            }
          }

          if (!state.hasTransformedClassName) {
            return;
          }

          const lastImportOrRequire = path
            .get("body")
            .filter(p => p.isImportDeclaration() || isRequire(p.node))
            .pop();

          if (lastImportOrRequire) {
            lastImportOrRequire.insertAfter(generateRequire(state.reqName));
          }
        }
      },
      ImportDeclaration: function importResolver(path, state) {
        var extensions =
          state.opts != null &&
          Array.isArray(state.opts.extensions) &&
          state.opts.extensions;

        if (!extensions) {
          throw new Error(
            "You have not specified any extensions in the plugin options."
          );
        }

        var node = path.node;
        var anonymousImports = path.container.filter(n => {
          return (
            t.isImportDeclaration(n) &&
            n.specifiers.length === 0 &&
            extensions.findIndex(ext => n.source.value.endsWith(ext)) > -1
          );
        });

        if (anonymousImports.length > 1) {
          throw new Error(
            "Cannot use anonymous style name with more than one stylesheet import."
          );
        }

        if (extensions.findIndex(ext => node.source.value.endsWith(ext)) === -1) {
          return;
        }

        specifier = node.specifiers[0];

        randomSpecifier = t.ImportDefaultSpecifier(
          path.scope.generateUidIdentifier()
        );

        node.specifiers = [specifier || randomSpecifier];
      },
      JSXOpeningElement: {
        exit(path, state) {
          var expressions = null;

          if (
            attribute === null ||
            randomSpecifier === null ||
            !(
              t.isStringLiteral(attribute.node.value) ||
              t.isJSXExpressionContainer(attribute.node.value)
            )
          ) {
            return;
          }

          if (t.isStringLiteral(attribute.node.value)) {
            var classNames = attribute.node.value.value
              .split(" ")
              .filter(v => v.trim() !== "");
            expressions = getStylesFromClassNames(classNames, state);
          } else if (t.isJSXExpressionContainer(attribute.node.value)) {
            expressions = [
              getStyleFromExpression(attribute.node.value.expression, state)
            ];
          }

          // It should not erase the attribute when different from `styleName`
          if (state.opts.attributeName && state.opts.attributeName !== "styleName") {
            path.node.attributes.push(t.JSXAttribute(t.JSXIdentifier(state.opts.attributeName), attribute.node.value));
          }

          var hasAttributeAndStyle =
            attribute &&
            style &&
            attribute.parentPath.node === style.parentPath.node;

          if (hasAttributeAndStyle) {
            style.node.value = t.arrayExpression(
              [style.node.value.expression].concat(expressions)
            );
            attribute.remove();
          } else {
            if (expressions.length > 1) {
              attribute.node.value = t.arrayExpression(expressions);
            } else {
              attribute.node.value = expressions[0];
            }
            attribute.node.name.name = "style";
          }

          const attritubes = state.opts.addAttributes || [];
          let shouldAddSpread = false;
          attritubes.forEach(attritube => {
            if (!expressions.length) {
              return;
            }
            const attrNode = path.node.attributes.find(attr => attr.name && attr.name.name === attritube);
            const expression = t.logicalExpression('&&', expressions[0], t.memberExpression(expressions[0], t.identifier(attritube)));

            if (attrNode) {
              attrNode.value = t.JSXExpressionContainer(t.logicalExpression('||', expression, attrNode.value.expression));
            } else {
              shouldAddSpread = true;
            }
          });

          if (shouldAddSpread) {
            path.node.attributes.unshift(t.JSXSpreadAttribute(expressions[0]));
          }

          style = null;
          attribute = null;
          specifier = null;
        }
      },
      JSXAttribute: function JSXAttribute(path, state) {
        var name = path.node.name.name;
        const attributeName = state.opts.attributeName || "styleName";

        if (name === attributeName) {
          state.hasAttribute = true;
          attribute = path;
        } else if (name === "style") {
          style = path;
        }
      }
    }
  };
};
