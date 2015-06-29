web3 = require "web3"
Init = require "./lib/init"
Create = require "./lib/create"
Config = require "./lib/config"
Contracts = require "./lib/contracts"
Build = require "./lib/build"
Test = require "./lib/test"

truffle_dir = process.env.TRUFFLE_NPM_LOCATION
working_dir = process.env.TRUFFLE_WORKING_DIRECTORY

module.exports = (grunt) ->
  config = Config.gather(truffle_dir, working_dir, grunt)

  web3.setProvider(config.provider)
  #console.log JSON.stringify(config, null, 2)

  # Remove grunt header and footer output.
  grunt.log.header = () ->
  grunt.fail.report = () ->

  grunt.initConfig
    pkg: grunt.file.readJSON('package.json')
    availabletasks: 
      tasks: 
        options:
          filter: 'exclude',
          tasks: ['availabletasks', 'default', 'list:after', 'deploy:contracts']
          descriptions:
            watch: 'Watch project for changes and rebuild app automatically'
          reporter: (options) ->
            heading = options.currentTask.name
            while heading.length < options.meta.longest
              heading += " "
            grunt.log.writeln("  #{heading} => #{options.currentTask.info}")
    watch: 
      build: 
        files: ["#{working_dir}/src/**/*", "#{working_dir}/lib/**/*", "#{working_dir}/config/**/*"] 
        tasks: ["build"] 
        options: 
          interrupt: true
          spawn: false
                 

  grunt.loadNpmTasks 'grunt-available-tasks'
  grunt.loadNpmTasks 'grunt-contrib-watch'

  grunt.registerTask 'list', "List all available tasks", () ->
    console.log "Truffle v#{grunt.config().pkg.version} - a development framework for Ethereum"
    console.log ""
    console.log "Commands:"
    console.log ""
    grunt.task.run "availabletasks"
    grunt.task.run "list:after"

  grunt.registerTask 'list:after', "Hidden: Simply print a line after 'list' runs", () ->
    console.log ""

  grunt.registerTask 'version', "Show version number and exit", () ->
    console.log "Truffle v#{grunt.config().pkg.version}"

  grunt.registerTask 'init', "Initialize new Ethereum project, including example contracts and tests", () ->
    Init.all(config, @async())

  grunt.registerTask 'init:contracts', "Initialize default contracts directory", () ->
    Init.contracts(config, @async())

  grunt.registerTask 'init:config', "Initialize default project configuration", () ->
    Init.config(config, @async())
    
  grunt.registerTask 'init:tests', "Initialize tests directory structure and helpers", () ->
    Init.tests(config, @async())

  grunt.registerTask 'create:contract', "Create a basic contract", () ->
    try 
      if typeof grunt.option("name") != "string"
        console.log "Please specify --name. Example: truffle create:contract --name 'MyContract'"
      else
        Create.contract(config, grunt.option("name"), @async())
    catch e
      console.log e.stack

  grunt.registerTask 'create:test', "Create a basic test", () ->
    try 
      if typeof grunt.option("name") != "string"
        console.log "Please specify --name. Example: truffle create:test --name 'MyContract'"
      else
        Create.test(config, grunt.option("name"), @async())
    catch e
      console.log e.stack

  grunt.registerTask 'compile', "Compile contracts", () ->
    done = @async()
    Contracts.compile_all config, (err) ->
      if err?
        console.log ""
        console.log err
        console.log ""
        console.log "Hint: Some clients don't send helpful error messages through the RPC. See client logs for more details."
      done()

  grunt.registerTask 'deploy', "Deploy contracts to the network", ["compile", "deploy:contracts"]
  grunt.registerTask 'deploy:contracts', "Hidden: Actual deployment function", () ->
    grunt.task.requires("compile")

    done = @async()
    Contracts.deploy config, (err) ->
      if err?
        console.log err
      done()

  grunt.registerTask 'build', "Build development version of app; creates ./build directory", () ->
    done = @async()
    # This one's a promise...
    Build.build(config).then(done).catch (err) ->
      console.log err.stack
      done()

  grunt.registerTask 'dist', "Create distributable version of app (minified); creates ./dist directory", () ->
    done = @async()
    # This one's a promise...
    Build.dist(config).then(done).catch (err) ->
      console.log err.stack
      done()

  # Supported options:
  # --no-color: Disable color
  # More to come.
  grunt.registerTask 'test', "Run tests", () ->
    done = @async()

    # Override the environment and reset the config.
    process.env.NODE_ENV = "test"
    config = Config.gather(truffle_dir, working_dir, grunt)
    grunt.option("quiet-deploy", true)
    Test.run config, (err, failures) ->
      if err?
        console.log err.stack
      process.exit(failures)

  grunt.registerTask 'default', ['list']