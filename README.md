\# WebLogic Monitor Extension



\## Overview



WebLogic Monitor is a Chrome Extension designed to monitor multiple WebLogic Admin Consoles independently.



The extension provides live monitoring of WebLogic managed servers with alerting, history tracking, CSV export, and domain-wise data separation.



\---



\# Features



\## 1. Multi WebLogic Domain Support



The extension supports monitoring multiple WebLogic Admin Consoles at the same time.



Example:



```

WebLogic Domain A

&#x20;       |

&#x20;       WLMonitor::domain-a





WebLogic Domain B

&#x20;       |

&#x20;       WLMonitor::domain-b

```



Each domain maintains separate:



\* Settings

\* Node history

\* Events

\* Remarks



Data from one WebLogic console does not appear in another console.



\---



\# 2. Live Node Monitoring



The extension monitors:



\* Node Name

\* Server Health

\* Server State

\* Open Sockets

\* Stuck Threads / Hogging Threads



Monitoring runs continuously while the WebLogic Console page is open.



The WebLogic console's own refresh mechanism remains responsible for table updates.



\---



\# 3. Severity Detection



The extension categorizes node status:



\## NORMAL



Condition:



```

Health = OK

State = RUNNING

Socket count below threshold

No stuck threads

```



\---



\## WARNING



Triggered when:



```

Health is not OK



OR



Socket threshold exceeded



OR



Stuck/Hogging thread detected

```



\---



\## CRITICAL



Triggered when:



```

Server state is not RUNNING

```



\---



\# 4. Stuck Thread Tracking



For impacted nodes, the extension maintains a remark field.



Example:



```

Node:



ManagedServer01





Remark:



Stuck Threads:

Thread-21

Thread-34

```



This helps identify which thread was stuck during the impacted period.



The remark remains associated with the impacted event history.



\---



\# 5. Alert System



Alert features:



\* Sound notification

\* Per-node acknowledgement

\* Alert repeat control

\* Recovery detection



ACK works independently for every node.



Example:



```

ManagedServer01

Status: ACKED





ManagedServer02

Status: ALERTING

```



Acknowledging one node does not suppress alerts from other nodes.



\---



\# 6. Settings Management



Settings are stored separately for every WebLogic domain.



Supported settings:



\* Socket threshold

\* Node ignore list

\* Alert preferences



Example:



```

Domain-A



ManagedServer01 threshold = 90





Domain-B



ManagedServer01 threshold = 70

```



Both configurations remain independent.



\---



\# 7. History Management



The extension uses IndexedDB.



Database:



```

WLMonitorDB

```



Stores:



```

WLMonitorDB



├── nodeHistory

├── allEvents

└── remarks

```



\---



\## nodeHistory



Retention:



```

Unlimited

```



Purpose:



\* Long term node impact tracking

\* Previous incident analysis



No automatic deletion is performed.



\---



\## allEvents



Retention:



```

7 Days

```



Purpose:



\* Live event timeline

\* Short term monitoring analysis



Automatic cleanup removes events older than 7 days.



\---



\# 8. Cleanup Process



Cleanup runs automatically.



Rules:



```

nodeHistory



KEEP FOREVER





allEvents



KEEP LAST 7 DAYS

```



Cleanup uses IndexedDB cursor based deletion to avoid browser performance issues with large data.



\---



\# 9. Export Feature



Supported exports:



```

Export All Events



Export Today Events

```



CSV contains:



```

ID

Domain

Node

Time

Health

Sockets

State

Severity

Remark

```



Export can be used before maintenance or cleanup activities.



\---



\# 10. User Interface



Floating monitoring panel provides:



```

Monitor



Impacted History



All Events



Export All



Export Today

```



The panel displays:



\* Current impacted nodes

\* Severity

\* Health

\* Socket count

\* State

\* Impact duration

\* Remark

\* ACK option



\---



\# Installation



\## Step 1



Open Chrome:



```

chrome://extensions

```



\---



\## Step 2



Enable:



```

Developer Mode

```



\---



\## Step 3



Click:



```

Load unpacked

```



\---



\## Step 4



Select extension folder:



```

WLMonitor

```



\---



\# Project Structure



```

WLMonitor



│

├── manifest.json

├── README.md

│

├── css

│   └── style.css

│

├── icons

│

└── src

&#x20;   │

&#x20;   ├── alerts.js

&#x20;   ├── cleanup.js

&#x20;   ├── content.js

&#x20;   ├── history.js

&#x20;   ├── monitor.js

&#x20;   ├── settings.js

&#x20;   ├── storage.js

&#x20;   └── ui.js

```



\---



\# Module Responsibilities



\## storage.js



Responsible for:



\* IndexedDB creation

\* Data storage

\* Domain isolation

\* Settings persistence



\---



\## settings.js



Responsible for:



\* Threshold management

\* Ignore node list

\* Domain based configuration



\---



\## alerts.js



Responsible for:



\* Alert generation

\* ACK handling

\* Sound notification

\* Repeat control



\---



\## cleanup.js



Responsible for:



\* 7 day allEvents cleanup

\* Retention management



\---



\## history.js



Responsible for:



\* History retrieval

\* CSV export

\* Event export



\---



\## monitor.js



Responsible for:



\* Node analysis

\* Severity calculation

\* Impact tracking

\* Remark handling



\---



\## content.js



Responsible for:



\* Reading WebLogic table

\* Extracting node information

\* Sending data to monitor engine



\---



\## ui.js



Responsible for:



\* Floating dashboard

\* Buttons

\* Impact display

\* History display



\---



\# Data Flow



```

WebLogic Console



&#x20;       |

&#x20;       |

&#x20;       ↓



content.js



&#x20;       |

&#x20;       |

&#x20;       ↓



monitor.js



&#x20;       |

&#x20;       +----------------+

&#x20;       |                |

&#x20;       ↓                ↓



storage.js          alerts.js



&#x20;       |

&#x20;       |

&#x20;       ↓



IndexedDB

```



\---



\# Supported Environment



Works with:



\* Chrome Extension Manifest V3

\* WebLogic Admin Console pages

\* Multiple WebLogic domains



\---



\# Future Enhancements



Planned improvements:



\* Thread dump capture

\* Automatic stuck thread report

\* Advanced pagination

\* Dashboard charts

\* Email notification

\* Server health trend analysis



\---



\# Author



Created for Mashkoor

