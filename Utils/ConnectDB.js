import mongoose from "mongoose";
import dotenv from 'dotenv'
dotenv.config();
//connection to db ..
const Connection = () => mongoose.connect(process.env.MONGODB_URI)
                    .then(()=>console.log("Database connected succesfully..!"))
                    .catch((e)=>console.log('Problem while connecting to db', e));

export default Connection
