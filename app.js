#!/usr/bin/env node
'use strict';

const blessed = require('blessed')
const contrib = require('blessed-contrib')
const bent = require('bent')
const wcwidth = require('wcwidth')
const events = require('events')
const fs = require('fs')
const chalk = require('chalk')
const util = require('util')
const inquirer = require('inquirer')
const fuzzy = require('fuzzy')
const funddb = require('./funddb')

inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'))

const readFile = util.promisify(fs.readFile)

// 盗取自blessed-contrib, 并将长度修改为wcwidth来计算保证对齐 ^_^
contrib.table.prototype.setData = function(tb) {
    var self = this;
    var dataToString = function(d) {
      var str = '';
      d.forEach(function(r, i) {
        var colsize = self.options.columnWidth[i]
          , stripLen = wcwidth(blessed.stripTags(r.toString()))
          , ansiLen = r.toString().length - stripLen
          , spaceLength = colsize - stripLen + self.options.columnSpacing;
        r = r.toString().substring(0, colsize + ansiLen);
        if (spaceLength < 0) {
          spaceLength = 0;
        }
        var spaces = new Array(spaceLength).join(' ');
        str += r + spaces;
      });
      return str;
    };
  
    var formatted = [];
  
    tb.data.forEach(function(d) {
      var str = dataToString(d);
      formatted.push(str);
    });
    this.setContent(dataToString(tb.headers));
    this.rows.setItems(formatted);
}


function numFmt(v, opt) {
    let {precision, percent, align, pch, pl, sign, tags} = Object.assign({
        precision: 2,
        percent: false,
        align: 'left',
        pch: '',
        pl: 4,
        sign: false,
        tags: true
    }, opt)
    v = v.toFixed(precision)
    let fg = v > 0 ? 'red' : (v == 0 ? 'grey' : 'green')
    if (sign) {
        v = v < 0 ? v : '+' + v
    }
    v = `${v}${percent ? '%' : ''}`
    switch (align) {
        case 'left':
            v = v.padStart(pl, pch)
            break
        case 'right':
            v = v.padEnd(pl, pch)
            break
        default:
            v = v.padStart(pl, pch)
            break
    }

    return tags ? `{${fg}-fg}${v}{/}` : v;
}

const fetchJson = bent('json', {'headers': {'X-Client': 'Fund-Man v0.0.1'}})

function fetchJsonWithRetry(uri, retry = 5){
    return fetchJson(uri).catch(e => {
        if (retry > 0) {
            return fetchJsonWithRetry(uri, retry - 1)
        }
        throw e
    })
}

/**
 * {
 *     title: xxx,
 *     debug: false,
 *     rows: xxx,
 *     cols: xxx
 * }
 * @param {Object} opts 
 */
function FundMan(opts) {

    if (!(this instanceof FundMan)) {
        return new FundMan(opts)
    }

    let self = this
    this.eventBus = new events.EventEmitter()
    this.screen = null
    this.done = 0
    this.tasks = []
    this.minIncome = Infinity
    this.maxIncome = -Infinity
    this.todayIncomeSummary = 0
    this.totalIncomeSummary = 0
    this.totalInvestment = 0
    this.lastError = null
    this.lastSelectedIndex = 0
    this.linesSeries = []
    this.opts = opts

    this.init = function (opts){
        opts = opts || self.opts
        self.screen = blessed.screen({
            smartCSR: true,
            fullUnicode: true,
            debug: opts.debug || false,
            title: opts.title || 'Fundman'
        })
        var grid = new contrib.grid({rows: opts.rows, cols: opts.cols, screen: self.screen})

        var widgetsCfg =  [
            {
                id: 'table',
                row: 0,
                col: 0,
                rowSpan: 5.8,
                colSpan: 8,
                obj: contrib.table,
                opts: {
                    keys: true,
                    interactive: true,
                    columnSpacing: 1,
                    columnSpacing: 10,
                    columnWidth: [24, 35, 20, 20],
                    label: ' Holding Funds ',
                    border: {type: 'line', fg: 'cyan'},
                    width: '100%',
                    height: '100%'
                }
            },
            {
                id: 'progress',
                row: 0,
                col: 8,
                rowSpan: 2,
                colSpan: 4,
                obj: contrib.gauge,
                opts: {
                    label: ' Progress ',
                    stroke: 'green',
                    fill: 'white',
                    padding: 0
                }
            },
            {
                id: 'line',
                row: 6,
                col: 0,
                rowSpan: 6,
                colSpan: 12,
                obj: contrib.line,
                opts: {
                    label: ' Stock Chart ',  
                    showLegend: true,
                    showNthLabel:10,
                    legend: {
                        width: 20
                    },
                }
            },
            {
                id: 'summary',
                row: 2,
                col: 8,
                rowSpan: 4,
                colSpan: 4,
                obj: blessed.text,
                opts: {
                    padding: 3,
                    style: {fg: 'green'},
                    label: ' Summary ',
                    tags: true,
                    border: {type: 'line', fg: 'cyan'},
                }
            }
        ]
        // 初始化组件
        this.widgets = {}
        for(var widget of widgetsCfg) {
            self.widgets[widget.id] = grid.set(widget.row, widget.col, widget.rowSpan, widget.colSpan, widget.obj, widget.opts)
        }

        // 消息提示框
        self.messageBox = blessed.message({
            parent: self.screen,
            border: 'line',
            height: 'shrink',
            width: 'half',
            top: 'center',
            left: 'center',
            label: ' {blue-fg}Tips{/blue-fg} ',
            tags: true,
            keys: true,
            hidden: true,
            vi: true,
            padding: 2
        })
        self.loader = blessed.loading(
            {
                parent: self.screen,
                border: 'line',
                height: 'shrink',
                width: 'half',
                // height: '10%',
                top: 'center',
                left: 'center',
                label: ' {blue-fg} Loading...{/} ',
                keys: true,
                tags: true,
                hidden: true,
                vi: true
            }
        )

        self.initEvent()
    }

    this.createTask = function(fund) {
        return fetchJsonWithRetry(`http://dp.jr.jd.com/service/fundValuation/${fund.code}.do`, 5).then(resp => {
            resp = resp[0]
            var rate = +resp.currentRating || 0
            var nowPrice = resp.currentNav || resp.fundNav
            var prevPrice = resp.fundNav
            var totalIncome = (nowPrice - fund.cost) * fund.holdings
            var totalRate = (nowPrice - fund.cost) * 100. / fund.cost
            var todayIncome = (nowPrice - prevPrice) * fund.holdings
            var investment =  fund.holdings * fund.cost
            self.todayIncomeSummary += todayIncome
            self.totalIncomeSummary += totalIncome
            self.totalInvestment += investment
            var series = (resp.data || []).filter(el => el[2] !== null).map(el => el[2])

            var r = {
                name: resp['fundShortName'],
                code: resp['fundCode'],
                holdings: fund.holdings,
                cost: fund.cost,
                investment: investment,
                rate: rate,
                totalRate: totalRate,
                todayIncome: todayIncome,
                totalIncome: totalIncome,
                series: series,
                timeRanges: timeRanges(240),
                minY: Math.min(...series)
            }

            self.eventBus.emit('task finished', r)

            return r
        }).catch(e => {
            self.lastError = e
        })
    }

    function timeRanges(count){
        // 9:30 - 11:30
        // 13:00 - 15: 00
        // 4h -> 240min
        // 120min
        let h = 9, m = 30
        let ranges = []
        for(var i = 0; i < Math.min(count, 240); i++) {
            ranges.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`)
            m += 1
            if (m >=60) {
                h += 1
                m = 0
            }
    
            // 到下午了
            if (h == 12) { h = 13 }
        }
        return ranges
    }

    this.initEvent = function() {
        self.eventBus.on('task finished', function(resp) {
            self.done += 1;
            var progess = self.widgets.progress
            // 更新进度表
            if (progess && self.tasks.length) {
                progess.setPercent(self.done / self.tasks.length)
                self.screen.render()
            }
        })
        self.widgets.table.rows.on('select', function(item, index) {
            self.refreshLineChart(index)
        })
    
        self.screen.key('?', function(){
            self.messageBox.display('{yellow-fg}你可以通过上下方向键选择对应的基金按回车键(enter)即可查看走势图^_^{/yellow-fg}\n\n\t\tCode by {underline}{bold}shellvon{/}({blue-fg}https://von.sh{/})', 5)
            self.screen.render()
        })
    
        self.screen.key(['escape', 'q', 'C-c'], (ch, key) => {
            return process.exit(0);
        })

        self.screen.on('resize', function() {
            for(var id in self.widgets) {
                self.widgets[id].emit('attach')
            }
            self.screen.render()
        })
    }

    this.refreshLineChart = function(index) {
        if (index !== undefined) {
            self.lastSelectedIndex = index
        }
        var series = self.linesSeries[self.lastSelectedIndex]
        if (series) {
            self.widgets.line.options.minY = series.minY
            self.widgets.line.setData(series)
        }
    }

    return self
}

FundMan.prototype.start = function(funds, interval = 5) {
    this.init()
    this.loader.load('{bold}首次运行, 数据加载中, 请稍后...{/bold}')
    this.mainloop(funds)
    setInterval(() => this.mainloop(funds), interval * 1e3)
}

FundMan.prototype.mainloop = function(funds) {
    this.done = 0
    this.isTradeTime = false
    this.todayIncomeSummary = this.totalIncomeSummary = this.totalInvestment = 0
    let self = this
    this.lastError = null
    self.tasks = [...new Map(funds.map(el => [el.code, el])).values()].map(fund => this.createTask(fund))
    Promise.all(this.tasks).then(function (funds) {
        var tableRows = [], linesSeries = []
        var isTradeTime = false
        for (var fund of funds) {
            if (!fund) {
                continue
            }
            tableRows.push(
                [
                    `${fund.name}(${fund.code})`,
                    `份额:${numFmt(fund.holdings, {pch: ' ', pl:8})},成本:${numFmt(fund.cost, {pch: ' ', pl:4})}, 合计: ${numFmt(fund.investment, {precision: 0})}`,
                    `${numFmt(fund.todayIncome, {pl: 4, sign: true, pch: ' '})}(${numFmt(fund.rate , {sign:true, percent:true})})`,
                    `${numFmt(fund.totalIncome, {pl: 4, sign: true, pch: ' '})}(${numFmt(fund.totalRate, {sign:true, percent:true})})`
                ]
            )
            isTradeTime = fund.series.length !== 0
    
            linesSeries.push({
                x: fund.timeRanges,
                y: fund.series, // record.slice(0, ~~ (100 * Math.random())),
                minY: fund.minY,
                title: `${fund.name.trim()}(${fund.code})`,
            })
        }
        self.minIncome = Math.min(self.minIncome, self.todayIncomeSummary)
        self.maxIncome = Math.max(self.maxIncome, self.todayIncomeSummary)
        self.linesSeries = linesSeries
        self.widgets.table.setData({headers: ['基金', '持仓信息', '今日预估收益', '累计收益'], data: tableRows})
        var summaryTextArr  = isTradeTime ?  [
                `累计投资金额: {yellow-fg}${self.totalInvestment.toFixed(2)}{/}`,
                `今日预估收益: ${numFmt(self.todayIncomeSummary, {sign: true})} 最低时:${numFmt(self.minIncome, {sign: true, pl:4, pch: ' '})} 最高时:${numFmt(self.maxIncome, {sign: true, pl:4, pch: ' '})}`,
                `累计预估收益: ${numFmt(self.totalIncomeSummary, {sign: true})}`,
                `累计收益率: ${numFmt(self.totalIncomeSummary * 100 / self.totalInvestment, {sign: true, percent: true})}`,
                `最后更新时间: {bold}${new Date().toLocaleString()}{/}`
        ] : [`{underline}{red-fg}{bold}当前时间为非交易时间段,请在交易时间范围内使用哦{/}`]
        if (self.lastError) {
            var m = self.lastError.message || self.lastError.toString()
            summaryTextArr.push(`{red-fg}{bold}${m}{/}`)
        }
        self.widgets.summary.setContent(summaryTextArr.join('\n'))
        self.widgets.table.focus()
        self.refreshLineChart()
        self.screen.render()
        self.loader.stop()
    })
}

const ask = function (app) {
    let delay = (val, ms) => new Promise((resolve) => setTimeout(() => resolve(val), ms))
    let funds  = []
    let questions = [
        {
            type: 'autocomplete',
            message: '请输入您所持有的基金代码,名称或简拼:',
            name: 'fund',
            source: (answersSoFar, input) => {
                return delay(fuzzy.filter(input || '', funddb, {extract: (el) => el.join('\n')})
                .filter(el => funds.findIndex(e => e.code === el.original[0]) == -1)
                .map(el => {
                    let display = `${el.original[2]}(${el.original[0]})`
                    return {
                        name: display,
                        short: display,
                        value: {
                            name: el.original[2],
                            code: el.original[0]
                        }
                    }
                }), 300)
            }
        },
        {
            type: 'number',
            message: '请输入您所持有的持仓成本价(便于您计算收益):',
            default: 0.00,
            name: 'cost',
        },
        {
            type: 'number',
            message: '请输入您所持有的份额(便于您计算收益):',
            default: 0.00,
            name: 'holdings'
        },
        {
            type: 'confirm',
            message: '是否还需要继续添加新的基金?(默认Yes)',
            default: true,
            name: 'askAgain'
        }
    ]

    let askRecursive = () => {
        inquirer.prompt(questions).then(answers => {
            funds.push(
                {
                    name:  answers.fund.name,
                    code: answers.fund.code,
                    holdings: answers.holdings,
                    cost: answers.cost,
                    time: + new Date()
                }
            )
            if (answers.askAgain) {
                return askRecursive()
            }
            console.log('\n')
            console.log(util.inspect(funds, {colors: true, depth: null}))
            inquirer.prompt([{
                type: 'confirm',
                name: 'save',
                message: '您需要将刚刚的基金数据保存至文件以备下一次使用吗?(默认Yes)',
                default: true
            }, {
                type: 'input',
                message: '请输入您的文件名(请确保原文件不存在,否则会保存失败):',
                name: 'fname',
                default: 'config.json',
                when: function (answer) {
                    return answer.save
                }
            }]).then(answer => {
                if (answer.save) {
                    fs.writeFile(answer.fname, JSON.stringify(funds, null, 4), {flag: 'wx', encoding: 'utf-8'}, (err) => {
                        if (err) {
                            return console.error(chalk.red('写入配置文件时出错~'))
                        } else {
                            console.log(chalk.greenBright(`已成本写入配置到文件:${chalk.bold(answers.fname)}`))
                        }
                    })
                }
                app.start(funds)
            })
        })
    }

    return askRecursive()
}

const run = function() {
    const cmd = process.argv[2]
    if (cmd == '-h' || cmd == '--help') {
        console.log(`Usage: ${process.argv[1]} <config-file>\n\t\tdefault config file is: ${process.cwd()}/config.json`)
        process.exit(1)
    } else if (/^--?\w+$/.test(cmd)) {
        console.log(`Invalid cmd/options\nUsage: ${process.argv[1]} <config-file>\n\t\tdefault config file is: ${process.cwd()}/config.json`)
    }
    let fname = cmd || `${__dirname}/config.json`

    console.log(chalk.greenBright(`尝试使用配置文件: ${chalk.red(fname)}`))

    const app = new FundMan({
        rows: 12,
        cols: 12,
        title: 'Richman',
        debug: false,
    })

    readFile(fname).then(content => {
       app.start(JSON.parse(content))
    }).catch(err => {
        if (err.code !== 'ENOENT') {
            return console.log(chalk.bgRed.bold(err.message))
            // throw err
        }
        console.log(chalk.yellowBright('Oops,您所指定的配置文件不存在,来新建吧'))
        ask(app)
    })
}

run()
