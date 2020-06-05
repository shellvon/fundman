#!/usr/bin/env node
'use strict';

const blessed = require('blessed')
const contrib = require('blessed-contrib')
const bent = require('bent')
const wcwidth = require('wcwidth')
const events = require('events')
const fs = require('fs')

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
    this.screen = blessed.screen({
        smartCSR: true,
        fullUnicode: true,
        debug: opts.debug || false,
        title: opts.title || 'Fundman'
    })
    var grid = new contrib.grid({rows: opts.rows, cols: opts.cols, screen: this.screen})
    this.eventBus = new events.EventEmitter()

    let self = this;

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
                columnWidth: [20, 35, 20, 20],
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
        this.widgets[widget.id] = grid.set(widget.row, widget.col, widget.rowSpan, widget.colSpan, widget.obj, widget.opts)
    }

    // 消息提示框
    this.messageBox = blessed.message({
        parent: this.screen,
        border: 'line',
        height: 'shrink',
        width: 'half',
        top: 'center',
        left: 'center',
        label: ' {blue-fg}Tips{/blue-fg} ',
        tags: true,
        keys: true,
        hidden: true,
        vi: true 
    })

    this.loader = blessed.loading(
        {
            parent: this.screen,
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
  
    this.done = 0
    this.tasks = []
    this.minIncome = Infinity
    this.maxIncome = -Infinity
    this.todayIncomeSummary = 0
    this.totalIncomeSummary = 0
    this.totalInvestment = 0

    var fetchJson = bent('http://dp.jr.jd.com/service/fundValuation', 'GET', 'json', 200)

    this.createTask = function(fund) {
        return fetchJson(`/${fund.code}.do`).then(resp => {
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

            this.eventBus.emit('task finished', r)

            return r
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
    
    this.eventBus.on('task finished', function(resp) {
        self.done += 1;
        var progess = self.widgets.progress
        // 更新进度表
        if (progess && self.tasks.length) {
            progess.setPercent(self.done / self.tasks.length)
            self.screen.render()
        }
    })

    this.lastSelectedIndex = 0
    this.linesSeries = []

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

    this.widgets.table.rows.on('select', function(item, index) {
        self.refreshLineChart(index)
    })

    this.screen.key('?', function(){
        self.messageBox.display('{yellow-fg}你可以通过上下方向键选择对应的基金按回车键(enter)即可查看走势图^_^{/yellow-fg}\n\t\tCode by {underline}{bold}shellvon{/}', 5)
        self.screen.render()
    })

    this.screen.key(['escape', 'q', 'C-c'], (ch, key) => {
        return process.exit(0);
    })

    
    this.screen.on('resize', function() {
        for(var widget of self.widgets) {
            widget.emit('attach')
        }
        self.screen.render()
    })

    return self
}


FundMan.prototype.start = function(funds, interval = 5) {
    this.loader.load('{bold}首次运行, 数据加载中, 请稍后...{/bold}')
    this.mainloop(funds)
    setInterval(() => this.mainloop(funds), interval * 1e3)
}

FundMan.prototype.mainloop = function(funds) {
    this.done = 0
    this.tasks = []
    this.isTradeTime = false
    this.todayIncomeSummary = this.totalIncomeSummary = this.totalInvestment = 0
    let self = this
    for (var fund of funds) {
        var task = this.createTask(fund)
        this.tasks.push(task)
    }
    Promise.all(this.tasks).then(function (funds) {
        var tableRows = [], linesSeries = []
        var isTradeTime = false
        for (var fund of funds) {
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
                title: `${fund.name}(${fund.code})`,
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
        self.widgets.summary.setContent(summaryTextArr.join('\n'))
        self.widgets.table.focus()
        self.refreshLineChart()
        self.screen.render()
        self.loader.stop()
    })
}

// 获取配置文件.
let cfg = `${process.cwd()}/config.json`
let argv = process.argv.slice(2, )
for(let i = 0, l = argv.length; i < l; i ++) {
    if (argv[i] == '-h') {
        console.log(`Usage: ${process.argv[1]} -c <config file>\n\t\tdefault config file is: ${cfg}`)
        process.exit(0)
    }
    if (argv[i] == '-c') {
        cfg = argv[i + 1]
    }
    if (l == 1) {
        cfg = argv[0]
    }
}

if (!cfg) {
    console.log('config file is required.')
    process.exit(1)
}

if (!fs.existsSync(cfg)) {
    console.log('config file is missing.....')
    process.exit(1)
}

const funds = require(cfg)

const app = new FundMan({
    rows: 12,
    cols: 12,
    title: 'Richman',
    debug: false,
    events: [],
})

app.start(funds)
