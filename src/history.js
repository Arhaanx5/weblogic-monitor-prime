const WLHistory = (() => {


    function getNodeHistory(){


        return window.WLStorage.getAll(

            window.WLStorage.STORES.NODE_HISTORY

        );


    }






    function getAllEvents(){


        return window.WLStorage.getAll(

            window.WLStorage.STORES.ALL_EVENTS

        );


    }







    async function getTodayEvents(){


        const data =
        await getAllEvents();



        const today =
        new Date()
        .toLocaleDateString();




        return data.filter(e => {


            return (

                new Date(e.time)
                .toLocaleDateString()

                ===

                today

            );


        });


    }









    function exportCSV(data,fileName){



        if(
            !data ||
            !data.length
        ){


            alert(
                "No data found"
            );


            return;


        }






        let csv =

`ID,Domain,Node,Time,Health,Sockets,State,Severity,Remark
`;







        data.forEach(row=>{


            csv += [

                row.id || "",

                row.domain || "",

                row.node || "",

                row.time || "",

                row.health || "",

                row.sockets || "",

                row.state || "",

                row.severity || "",

                row.remark || ""

            ]

            .map(value => {


                return (

                    '"' +

                    String(value)
                    .replaceAll('"','""')

                    +

                    '"'

                );


            })


            .join(",");



            csv += "\n";



        });








        const blob =
        new Blob(

            [csv],

            {
                type:
                "text/csv;charset=utf-8"
            }

        );





        const url =
        URL.createObjectURL(blob);




        const a =
        document.createElement("a");



        a.href =
        url;



        a.download =
        fileName;



        document.body.appendChild(a);



        a.click();



        a.remove();



        URL.revokeObjectURL(url);



    }









    async function exportAll(){


        const data =
        await getAllEvents();



        exportCSV(

            data,

            "WLMonitor_AllEvents.csv"

        );


    }









    async function exportToday(){


        const data =
        await getTodayEvents();



        exportCSV(

            data,

            "WLMonitor_TodayEvents.csv"

        );


    }









    return {


        getNodeHistory,

        getAllEvents,

        getTodayEvents,

        exportAll,

        exportToday


    };



})();



window.WLHistory = WLHistory;