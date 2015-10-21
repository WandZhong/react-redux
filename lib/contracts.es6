var async = require("async");
var fs = require("fs");
var mkdirp = require("mkdirp");
var path = require("path");
var solc = require("solc");
var path = require("path");
var Pudding = require("ether-pudding");
var PuddingGenerator = require("ether-pudding/generator");
var ConfigurationError = require("./errors/configurationerror");
var CompileError = require("./errors/compileerror");
var DeployError = require("./errors/deployerror");

var Contracts = {
  resolve_headers(root) {
    root = path.resolve(root);
    var contract_name = path.basename(root).replace(/\.[^\.]*$/, "");

    var reduce_signature = function(signature) {
      return signature.reduce(function(previous, current, index) {
        var sig = "";
        if (index > 0) {
          sig += ", ";
        }
        sig += current.type;
        if (current.name != null && current.name != "") {
          sig += ` ${current.name}`;
        }
        return previous + sig;
      }, "");
    };

    var make_function = function(name, fn) {
      var returns = "";

      if (fn.outputs != null && fn.outputs.length > 0) {
        returns = ` returns (${reduce_signature(fn.outputs)})`;
      }

      return `  function ${name}(${reduce_signature(fn.inputs)})${returns}; \n`;
    };

    var code = this.resolve(root);

    var result = solc.compile(code, 0);

    if (result.errors != null) {
      throw new CompileError(result.errors.join(), root);
    }

    var compiled_contract = result.contracts[contract_name];
    var abi = JSON.parse(compiled_contract.interface);

    var headers = `contract ${contract_name} { \n`;

    for (var fn of abi) {
      switch(fn.type) {
        case "constructor":
          headers += make_function(contract_name, fn)
          break;
        case "function":
          headers += make_function(fn.name, fn);
          break;
        default:
          throw new Error(`Unknown type ${fn.type} found in ${root}`);
      }
    }

    headers += `} \n`;

    return headers;
  },

  resolve(root) {
    var imported = {};

    var import_file = (file) => {
      var code = fs.readFileSync(file, "utf-8");

      // Remove comments
      code = code.replace(/(\/\/.*(\n|$))/g, "");
      code = code.replace(/(\/\*(.|\n)*?\*\/)/g, "");
      code = code.replace("*/", ""); // Edge case.

      // Perform imports.
      code = code.replace(/import(_headers)? ('|")[^'"]+('|");/g, (match) => {
        match = match.replace(/'/g, '"');
        var import_name = match.split('"')[1];
        var import_path = path.dirname(file) + "/" + import_name + ".sol";

        // Don't import the same thing twice if there are two of the same dependency.
        if (imported[import_name] == true) {
          return "";
        }

        if (!fs.existsSync(import_path)) {
          throw `Could not find source for '${import_name} from ${file}'. Expected: ${import_path}`
        }

        imported[import_name] = true;

        if (match.indexOf("import_headers") == 0) {
          return this.resolve_headers(import_path) + "\n\n";
        } else {
          return import_file(import_path) + "\n\n";
        }
      });
      return code;
    };

    return import_file(root);
  },

  // Support the breaking change that made sendTransaction return a transaction
  // hash instead of an address hash when committing a new contract.
  get_contract_address(config, address_or_tx, callback) {
    if (address_or_tx.length == 42) {
      callback(null, address_or_tx);
      return;
    }

    var attempts = 0;
    var max_attempts = 120;

    var interval = null;
    var verify = function() {
      // Call the method via the provider directly as it hasn't yet been
      // implemented in web3.
      config.web3.currentProvider.sendAsync({
        jsonrpc: "2.0",
        method: "eth_getTransactionReceipt",
        params:[address_or_tx],
        id: new Date().getTime()
      }, function(err, result) {
        if (err != null) {
          callback(err);
          return;
        }

        result = result.result;

        // Gotta love inconsistent responses.
        if (result != null && result != "" && result != "0x") {
          clearInterval(interval);
          callback(null, result.contractAddress);
          return;
        }

        attempts += 1;

        if (attempts >= max_attempts) {
          clearInterval(interval);
          callback(new Error(`Contracts not deployed after ${attempts} seconds!`));
        }
      });
    };

    interval = setInterval(verify, 1000);
  },

  compile_all(config, callback) {
    async.mapSeries(Object.keys(config.contracts.classes), (key, finished) => {
      var contract = config.contracts.classes[key];
      var source = contract.source;
      var full_path = path.resolve(config.working_dir, source);

      if (config.argv.quietDeploy == null) {
        console.log(`Compiling ${source}...`);
      }

      var code;

      try {
        code = this.resolve(full_path);
      } catch (e) {
        finished(e);
        return;
      }

      var result = solc.compile(code, 1);

      if (result.errors != null) {
        finished(new CompileError(result.errors.join(), source));
        return;
      }

      var compiled_contract = result.contracts[key];

      contract["binary"] = compiled_contract.bytecode;
      contract["abi"] = JSON.parse(compiled_contract.interface);

      finished(null, contract);
    }, callback);
  },

  write_contracts(config, description="contracts", callback) {
    mkdirp(config.environments.current.directory, function(err, result) {
      if (err != null) {
        callback(err);
        return;
      }

      var display_directory = "./" + path.join("./", config.environments.current.contracts_filename.replace(config.working_dir, ""));
      if (config.argv.quietDeploy == null) {
        console.log(`Writing ${description} to ${display_directory}`);
      }

      PuddingGenerator.save(config.contracts.classes, config.environments.current.directory, {removeExisting: true});

      callback();
    });
  },

  compile(config, callback) {
    async.series([
      (c) => {
        config.test_connection(function(error, coinbase) {
          if (error != null) {
            callback(new Error("Could not connect to your Ethereum client. Truffle uses your Ethereum client to compile contracts. Please ensure your client is running and can compile the all contracts within the contracts directory."));
          } else {
            c();
          }
        });
      },
      (c) => {
        this.compile_all(config, c);
      },
      (c) => {
        this.write_contracts(config, "contracts", c);
      }
    ], callback);
  },

  deploy(config, compile=true, done_deploying) {
    var coinbase = null;

    async.series([
      (c) => {
        config.web3.eth.getCoinbase(function(error, result) {
          coinbase = result;
          c(error, result);
        });
      },
      (c) => {
        if (compile == true) {
          this.compile_all(config, c);
        } else {
          c();
        }
      },
      (c) => {
        // Put them on the network
        async.mapSeries(config.app.resolved.deploy, (key, callback) => {
          var contract_class = config.contracts.classes[key];

          class contract extends Pudding {}

          contract.abi = contract_class.abi;
          contract.binary = contract_class.binary;
          contract.setWeb3(config.web3);

          if (contract == null) {
            callback(new Error(`Could not find contract '${key}' for deployment. Check app.json.`));
            return;
          }

          var display_name = path.basename(contract_class.source);
          if (config.argv.quietDeploy == null) {
            console.log(`Sending ${display_name} to the network...`);
          }

          contract.new({
            from: coinbase,
            gas: 3141592,
            gasPrice: 1000000000000 // I'm not sure why this is so high. geth made me do it.
          }).then(function(instance) {
            contract_class.address = instance.address;
            callback(null, contract_class);
          }).catch(function(err) {
            callback(new DeployError(err.message, key));
          });

        }, c);
      }
    ], (err) => {
      if (err != null) {
        done_deploying(err);
        return;
      }

      this.write_contracts(config, "contracts and deployed addresses", done_deploying);
    });
  }
}

module.exports = Contracts;
